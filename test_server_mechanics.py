import unittest

import server


class SimMechanicsTests(unittest.TestCase):
    def setUp(self):
        self.sim = server.Sim()
        self.sim.users = []
        self.sim.probes = []
        self.sim._grid = {}
        self.sim._grid_dirty = True
        self.sim.rev = 0
        self.sim.user_seq = 0

    def make_user(self, name, logged_in=True):
        u = self.sim._new_user({
            "name": name,
            "email": f"{name.lower()}@example.com",
            "loggedIn": logged_in,
        })
        self.sim.users.append(u)
        return u

    def test_effective_pull_target_uses_heartbeat_and_jam_floor(self):
        user = self.make_user("Alpha")
        self.assertAlmostEqual(self.sim.effective_pull_target(user), 0.6)

        user["heartbeatUntil"] = server.now_ms() + 4000
        self.assertAlmostEqual(self.sim.effective_pull_target(user), 1.0)

        user["heartbeatUntil"] = 0
        self.assertAlmostEqual(self.sim.effective_pull_target(user), 0.6)

        rival = self.make_user("Beta")
        rival["jamStack"] = 1
        rival["jammedUntil"] = server.now_ms() + 15000
        self.assertAlmostEqual(self.sim.effective_pull_target(rival), 0.5)

        rival["jamStack"] = 3
        self.assertAlmostEqual(self.sim.effective_pull_target(rival), 0.3)

    def test_jam_applies_cooldown_and_stacks(self):
        jammer = self.make_user("Jammer")
        target = self.make_user("Target")
        jammer["token"] = "secret"

        first = self.sim.jam_user(jammer["id"], target["id"], "secret")
        self.assertTrue(first["ok"])
        self.assertEqual(target["jamStack"], 1)
        self.assertGreater(target["jammedUntil"], server.now_ms())

        second = self.sim.jam_user(jammer["id"], target["id"], "secret")
        self.assertFalse(second["ok"])
        self.assertEqual(second["error"], "cooldown")


if __name__ == "__main__":
    unittest.main()
