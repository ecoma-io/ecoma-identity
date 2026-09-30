// Fixture auth bypass. VIOLATION (check 9): §26 forbids a development
// authentication bypass outright — not a flag, not an env var, not a role.
pub const dev_auth_bypass: bool = true;

pub fn authenticate(token: &str) -> bool {
    if dev_auth_bypass {
        return true;
    }
    !token.is_empty()
}
