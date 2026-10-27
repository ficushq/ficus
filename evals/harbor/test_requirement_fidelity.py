import unittest

from coordination import CONTRACT, handoff


class RequirementFidelityTests(unittest.TestCase):
    def test_both_harnesses_receive_identical_preservation_contract_and_original(self):
        request = 'A requirement with exact spacing:  ["x", "y"]\nLater amendment.'
        for harness in ("ficus", "pi"):
            prompt = handoff(request, harness)
            self.assertTrue(prompt.startswith(CONTRACT))
            self.assertEqual(
                prompt.split("BEGIN REQUESTS\n", 1)[1], request + "\nEND REQUESTS"
            )
            self.assertEqual(prompt.count("Preserve the original request text"), 1)
            self.assertIn(
                "Original requirements take precedence over derived plans", CONTRACT
            )


if __name__ == "__main__":
    unittest.main()
