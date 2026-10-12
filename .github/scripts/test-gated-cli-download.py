import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("verify-gated-cli-download.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class Gates(unittest.TestCase):
    def setUp(self):
        self.sha = "a" * 40
        self.run = dict(id=123, head_sha=self.sha, head_branch="main", event="workflow_dispatch",
                        path=".github/workflows/release.yml")
        self.jobs = {"jobs": [dict(name=name, conclusion="success") for name in guard.GATES]}

    def test_exact_official_main_run(self):
        guard.validate_run(self.run, self.jobs, self.sha, "123")

    def test_other_source_or_branch_rejected(self):
        for patch in ({"head_sha": "b" * 40}, {"head_branch": "feature"}, {"event": "pull_request"},
                      {"path": ".github/workflows/other.yml"}, {"id": 124}):
            with self.assertRaises(ValueError):
                guard.validate_run(self.run | patch, self.jobs, self.sha, "123")

    def test_every_gate_required(self):
        for i in range(len(guard.GATES)):
            jobs = copy.deepcopy(self.jobs)
            jobs["jobs"][i]["conclusion"] = "failure"
            with self.assertRaises(ValueError):
                guard.validate_run(self.run, jobs, self.sha, "123")

    def test_short_sha_rejected(self):
        with self.assertRaises(ValueError):
            guard.validate_run(self.run, self.jobs, "a" * 7, "123")

    def different_workflow_head(self):
        run = self.run | {"head_sha": "b" * 40}
        jobs = copy.deepcopy(self.jobs)
        jobs["jobs"][0].update(id=456, run_id=123, head_sha=run["head_sha"],
                               steps=[dict(name="Verify and bind release source", conclusion="success")])
        raw = ["[command]/usr/bin/git log -1 --format=%H", self.sha,
               '##[group]Run if [[ "$PUBLISH" == true ]]; then bash .github/scripts/verify-release-main.sh; fi',
               "  PUBLISH: true", "  RELEASE_COMMIT: " + self.sha, "##[endgroup]"]
        log = "\n".join("2026-10-12T13:20:56.0000000Z " + line for line in raw)
        return run, jobs, log

    def test_actual_checkout_can_differ_from_workflow_main_head(self):
        run, jobs, log = self.different_workflow_head()
        guard.validate_run(run, jobs, self.sha, "123", log)

    def test_wrong_checkout_or_guard_input_still_rejected(self):
        run, jobs, log = self.different_workflow_head()
        for bad in (log.replace(self.sha, "c" * 40), log.replace("PUBLISH: true", "PUBLISH: false"),
                    log.replace("RELEASE_COMMIT: " + self.sha, "RELEASE_COMMIT: " + "c" * 40),
                    log.replace("##[endgroup]", ""), log + "\n" + log):
            with self.assertRaises(ValueError):
                guard.validate_run(run, jobs, self.sha, "123", bad)

    def test_original_build_identity_and_guard_must_match(self):
        run, jobs, log = self.different_workflow_head()
        for patch in ({"run_id": 124}, {"head_sha": "c" * 40}, {"id": None},
                      {"steps": [dict(name="Verify and bind release source", conclusion="failure")]}):
            bad = copy.deepcopy(jobs)
            bad["jobs"][0].update(patch)
            with self.assertRaises(ValueError):
                guard.validate_run(run, bad, self.sha, "123", log)

    def test_checkout_proof_does_not_replace_main_or_package_gates(self):
        run, jobs, log = self.different_workflow_head()
        for patch in ({"head_branch": "feature"}, {"event": "pull_request"},
                      {"path": ".github/workflows/other.yml"}, {"id": 124}):
            with self.assertRaises(ValueError):
                guard.validate_run(run | patch, jobs, self.sha, "123", log)
        for i in range(len(guard.GATES)):
            bad = copy.deepcopy(jobs)
            bad["jobs"][i]["conclusion"] = "failure"
            with self.assertRaises(ValueError):
                guard.validate_run(run, bad, self.sha, "123", log)


if __name__ == "__main__":
    unittest.main()
