"""1D U-Net over the 256 time steps, conditioned with FiLM on (flow time + movement conditions).

Input/output channels: canonical x, canonical y and log(movement time) as a constant third channel,
so the path and its duration are generated together. Every op exports to ONNX opset 17 and runs in
onnxruntime-web (WebGPU and WASM).
"""
from __future__ import annotations

import math

import torch
from torch import nn
from torch.nn import functional as F


class TimeEmbedding(nn.Module):
    def __init__(self, dim: int = 128):
        super().__init__()
        self.dim = dim

    def forward(self, t: torch.Tensor) -> torch.Tensor:
        half = self.dim // 2
        freqs = torch.exp(-math.log(10000.0) * torch.arange(half, device=t.device, dtype=t.dtype) / half)
        a = (t * 1000.0)[:, None] * freqs[None]
        return torch.cat([torch.sin(a), torch.cos(a)], dim=1)


class ResBlock(nn.Module):
    def __init__(self, cin: int, cout: int, emb: int, groups: int = 8):
        super().__init__()
        self.n1 = nn.GroupNorm(groups, cin)
        self.c1 = nn.Conv1d(cin, cout, 3, padding=1)
        self.film = nn.Linear(emb, 2 * cout)
        self.n2 = nn.GroupNorm(groups, cout)
        self.c2 = nn.Conv1d(cout, cout, 3, padding=1)
        self.skip = nn.Conv1d(cin, cout, 1) if cin != cout else nn.Identity()

    def forward(self, x, e):
        h = self.c1(F.silu(self.n1(x)))
        scale, shift = self.film(e).chunk(2, dim=1)
        h = self.n2(h) * (1 + scale[:, :, None]) + shift[:, :, None]
        h = self.c2(F.silu(h))
        return h + self.skip(x)


class Attention(nn.Module):
    def __init__(self, ch: int, heads: int = 4, groups: int = 8):
        super().__init__()
        self.heads = heads
        self.norm = nn.GroupNorm(groups, ch)
        self.qkv = nn.Conv1d(ch, 3 * ch, 1)
        self.out = nn.Conv1d(ch, ch, 1)

    def forward(self, x):
        b, c, n = x.shape
        q, k, v = self.qkv(self.norm(x)).reshape(b, 3, self.heads, c // self.heads, n).unbind(1)
        # plain MatMul/Softmax (no Einsum) so every onnxruntime-web backend can run it
        w = torch.softmax(torch.matmul(q.transpose(-1, -2), k) / math.sqrt(c // self.heads), dim=-1)
        y = torch.matmul(v, w.transpose(-1, -2)).reshape(b, c, n)
        return x + self.out(y)


class UNet1D(nn.Module):
    def __init__(self, cond_dim: int, in_ch: int = 3, base: int = 64, mults=(1, 2, 4, 4), emb: int = 256):
        super().__init__()
        self.temb = nn.Sequential(TimeEmbedding(128), nn.Linear(128, emb), nn.SiLU(), nn.Linear(emb, emb))
        self.cemb = nn.Sequential(nn.Linear(cond_dim, emb), nn.SiLU(), nn.Linear(emb, emb))
        self.inp = nn.Conv1d(in_ch, base, 3, padding=1)
        chs = [base * m for m in mults]
        self.down = nn.ModuleList()
        self.downsample = nn.ModuleList()
        cin = base
        skips = []
        for i, c in enumerate(chs):
            self.down.append(nn.ModuleList([ResBlock(cin, c, emb), ResBlock(c, c, emb)]))
            skips.append(c)
            cin = c
            self.downsample.append(nn.Conv1d(c, c, 3, stride=2, padding=1) if i < len(chs) - 1 else nn.Identity())
        self.mid1 = ResBlock(cin, cin, emb)
        self.attn = Attention(cin)
        self.mid2 = ResBlock(cin, cin, emb)
        self.up = nn.ModuleList()
        self.upconv = nn.ModuleList()
        for i, c in reversed(list(enumerate(chs))):
            self.up.append(nn.ModuleList([ResBlock(cin + skips[i], c, emb), ResBlock(c, c, emb)]))
            cin = c
            self.upconv.append(nn.Conv1d(c, c, 3, padding=1) if i > 0 else nn.Identity())
        self.out_norm = nn.GroupNorm(8, cin)
        self.out = nn.Conv1d(cin, in_ch, 3, padding=1)
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)

    def forward(self, x, t, cond):
        e = self.temb(t) + self.cemb(cond)
        h = self.inp(x)
        hs = []
        for (b1, b2), ds in zip(self.down, self.downsample):
            h = b2(b1(h, e), e)
            hs.append(h)
            h = ds(h)
        h = self.mid2(self.attn(self.mid1(h, e)), e)
        n_up = len(self.up)
        for j, ((b1, b2), uc) in enumerate(zip(self.up, self.upconv)):
            skip = hs.pop()
            if h.shape[-1] != skip.shape[-1]:
                h = F.interpolate(h, size=skip.shape[-1], mode="nearest")
            h = b2(b1(torch.cat([h, skip], dim=1), e), e)
            if j < n_up - 1:
                h = uc(h)
        return self.out(F.silu(self.out_norm(h)))


def count_params(m: nn.Module) -> int:
    return sum(p.numel() for p in m.parameters())
