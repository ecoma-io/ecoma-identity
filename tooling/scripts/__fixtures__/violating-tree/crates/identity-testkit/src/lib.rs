// Fixture testkit. It holds the domain's vocabulary on purpose and is exempt,
// which is the exemption the jobs check has to respect: a test double is not
// a product dependency.
pub struct FakeUserRepository;
