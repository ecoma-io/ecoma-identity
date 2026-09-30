// Fixture Admin Worker, and the violation the brief names first.
//
// VIOLATION (check 1, source half): `env.IDENTITY_DB` opens the identity
// database from the Worker that must reach identity only through a private
// service binding. This is code, not prose, so it is a VIOLATION rather than a
// warning — which is the distinction `isProseLine` exists to make.
pub fn fetch(env: &worker::Env) -> worker::Result<worker::Response> {
    let db = env.d1("IDENTITY_DB")?;
    db.prepare("SELECT 1").run().await.map(|_| worker::Response::ok())
}
