#!/usr/bin/env bash
. "$(dirname "$0")/harness.sh"

TPL="$AWS_DIR/../shared-infra-template"

test_compose_mounts_acme_outside_var_www_and_uses_external_network() {
  python - "$TPL/docker-compose.yml" <<'EOF'
import sys, yaml
c = yaml.safe_load(open(sys.argv[1]))
vols = c["services"]["nginx"]["volumes"]
assert "./nginx/acme:/var/lib/acme:ro" in vols, vols
targets = [v.split(":")[1] for v in vols]
assert not any(t.startswith("/var/www/") for t in targets), "no mount may nest under the read-only /var/www"
net = c["networks"]["default"]
assert net == {"name": "shared-infra_default", "external": True}, net
EOF
}

test_acme_location_is_in_port_80_block_before_redirect() {
  conf="$TPL/nginx/conf.d/10-shared-edge.conf"
  acme=$(grep -n 'location \^~ /.well-known/acme-challenge/' "$conf" | cut -d: -f1)
  redirect=$(grep -n 'return 301 https' "$conf" | cut -d: -f1)
  tls=$(grep -n 'listen 443' "$conf" | cut -d: -f1)
  [ -n "$acme" ] || fail "acme location missing"
  [ "$acme" -lt "$redirect" ] || fail "acme location must precede the redirect"
  [ "$acme" -lt "$tls" ] || fail "acme location must be in the port-80 block"
  assert_contains "$(sed -n "${acme},$((acme + 3))p" "$conf")" "root /var/lib/acme;"
}

test_acme_dir_is_tracked() {
  [ -f "$TPL/nginx/acme/.gitkeep" ] || fail "nginx/acme/.gitkeep missing"
}

run_tests
