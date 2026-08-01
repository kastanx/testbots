export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }) {
    const params = await searchParams;
    return (
        <main>
            <form className="login" method="post" action="/api/login">
                <h1>greenbot</h1>
                {params?.bad && <div className="banner bad">Wrong password.</div>}
                <input
                    type="password"
                    name="password"
                    placeholder="password"
                    autoFocus
                    autoComplete="current-password"
                />
                <button className="go" type="submit">Open</button>
            </form>
        </main>
    );
}
