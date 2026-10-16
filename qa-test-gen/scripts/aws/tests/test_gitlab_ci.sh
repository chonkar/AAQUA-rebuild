#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

CI_FILE="$AWS_DIR/../../../.gitlab-ci.yml"

test_two_deploy_jobs_with_distinct_tags_and_environments() {
  python - "$CI_FILE" <<'EOF'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
base = c[".deploy"]
assert base["stage"] == "deploy"
assert any("publish-spa.sh" in line for line in base["script"])
assert base["rules"] == [{"if": '$CI_COMMIT_BRANCH == "main"'}]
for job, tag, env in [("deploy:gcp", "aaqua-deploy", "gcp-qa"), ("deploy:aws", "aaqua-deploy-aws", "aws-qa")]:
    j = c[job]
    assert j["extends"] == ".deploy", job
    assert j["tags"] == [tag], (job, j["tags"])
    assert j["environment"]["name"] == env, job
assert "deploy" not in c, "old single job must be removed"
EOF
}

run_tests
