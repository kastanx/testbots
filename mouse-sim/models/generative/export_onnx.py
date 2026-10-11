"""Export the trained network to ONNX plus everything the browser sampler needs (gen.json):
normalisation, the condition layout, the session vector, step count and the timing banks."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import torch

from pipeline import config, paths
from pipeline.dataset import Dataset

from . import data
from .train import load


class _Exportable(torch.nn.Module):
    """The bare U-Net: the session embedding (if any) is baked into the condition vector instead."""

    def __init__(self, model):
        super().__init__()
        self.net = model.net

    def forward(self, x, t, cond):
        return self.net(x, t, cond)


def export(run=None, out=None, data_root=None) -> Path:
    model, cfg, norm = load(run, "cpu")
    out = Path(out) if out else paths.EXPORT / "gen"
    out.mkdir(parents=True, exist_ok=True)
    sess_vec = None
    cond_dim = len(cfg["cond_names"])
    if cfg["session_embedding"]:
        sess_vec = model.sess.weight[len(cfg["sessions"]) - 1].detach().numpy().tolist()
        cond_dim += cfg["session_embedding"]
    net = _Exportable(model).eval()
    x = torch.randn(2, data.IN_CHANNELS, data.N_POINTS)
    t = torch.rand(2)
    c = torch.randn(2, cond_dim)
    torch.onnx.export(net, (x, t, c), out / "model.onnx", input_names=["x", "t", "cond"], output_names=["v"],
                      dynamic_axes={"x": {0: "batch"}, "t": {0: "batch"}, "cond": {0: "batch"}, "v": {0: "batch"}},
                      opset_version=17, dynamo=False)
    import onnxruntime as ort
    sess = ort.InferenceSession(str(out / "model.onnx"), providers=["CPUExecutionProvider"])
    xs, ts, cs = torch.randn(5, data.IN_CHANNELS, data.N_POINTS), torch.rand(5), torch.randn(5, cond_dim)
    with torch.no_grad():
        ref = net(xs, ts, cs).numpy()
    got = sess.run(["v"], {"x": xs.numpy(), "t": ts.numpy(), "cond": cs.numpy()})[0]
    err = float(np.max(np.abs(ref - got)))
    if err > 1e-3:
        raise RuntimeError(f"ONNX output differs from PyTorch by {err}")
    ds = Dataset(data_root or cfg["data_root"])
    meta = {
        "format": 2, "n_points": data.N_POINTS, "d_min": data.D_MIN, "in_ch": data.IN_CHANNELS,
        "sampling": config.generative(), "cond_names": cfg["cond_names"], "norm": norm, "session_vector": sess_vec,
        "run": Path(cfg["run_dir"]).name, "ckpt_step": cfg["ckpt_step"], "params": cfg["params"],
        "banks": data.build_banks(ds, include_warmup=config.generative().get("include_warmup", False)),
        "onnx_check_max_abs_err": err,
    }
    (out / "gen.json").write_text(json.dumps(meta, separators=(",", ":")))
    print(f"exported {out / 'model.onnx'} ({(out / 'model.onnx').stat().st_size / 1e6:.1f} MB, "
          f"ONNX vs PyTorch max error {err:.2e})")
    return out
