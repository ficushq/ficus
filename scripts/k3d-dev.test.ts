import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const script = readFileSync(join(import.meta.dir, 'k3d-dev.sh'), 'utf8')
const compose = readFileSync(join(import.meta.dir, '..', 'docker-compose.yml'), 'utf8')

describe('k3d-dev.sh local image safeguards', () => {
  test('docker compose provides a local registry for k3d sandbox image pulls', () => {
    expect(compose).toContain('registry:')
    expect(compose).toContain('container_name: ficus-registry')
    expect(compose).toContain('registry-data:/var/lib/registry')
    expect(compose).toContain("'127.0.0.1:5001:5000'")
    expect(compose).toContain('name: ficus-dev')
  })

  test('k3d setup/import pushes sandbox image to the compose registry instead of relying on node-only image import', () => {
    expect(script).toContain('REGISTRY_CONTAINER="ficus-registry"')
    expect(script).toContain('docker compose up -d registry')
    expect(script).toContain('K3D_NETWORK="${FICUS_K3D_NETWORK:-ficus-dev}"')
    expect(script).toContain('--network "${K3D_NETWORK}"')
    expect(script).toContain('docker network connect "${network}" "${REGISTRY_CONTAINER}"')
    expect(script).toContain('docker push "${REGISTRY_IMAGE}"')
    expect(script).toContain('write_registry_config')
    expect(script).not.toContain('k3d image import "${SANDBOX_IMAGE}"')
  })

  test('removes any stale pre-registry k3d image import tarballs after publishing the image', () => {
    expect(script).toContain('cleanup_import_archives')
    expect(script).toContain('find /k3d/images -name "*.tar" -type f -delete')
    expect(script).toContain('remaining_archive_bytes')
    expect(script).toMatch(/build_and_push_sandbox_image[\s\S]*cleanup_import_archives/)
  })

  test('import/setup prune stale node images so containerd does not accumulate old sandbox layers', () => {
    expect(script).toContain('prune_node_images')
    expect(script).toContain('crictl rmi --prune')
    // Prune runs as part of both build paths, after archive cleanup.
    expect(script).toMatch(/cleanup_import_archives\s*\n\s*prune_node_images/)
  })

  test('status reports k3d node disk usage and warns when image archives consume space', () => {
    expect(script).toContain('format_bytes')
    expect(script).toContain('image_archive_bytes')
    expect(script).toContain('/k3d/images')
    expect(script).toContain('Node disk:')
    expect(script).toContain('Image archives:')
  })

  test('status image check normalizes grep count to a single numeric value', () => {
    expect(script).toMatch(/grep -c .*SANDBOX_IMAGE.*\|\| true/)
    expect(script).toContain('image_loaded=${image_loaded:-0}')
  })

  // I2 (fix round 1): a pre-rename legacy-named cluster is a SEPARATE k3d
  // cluster this script can no longer see by name — it must say so
  // explicitly, with the exact commands to migrate or delete it, rather than
  // silently leaving it running.
  test('setup and status both warn when the legacy dev cluster is still present', () => {
    expect(script).toContain('LEGACY_CLUSTER_NAME="tau-dev"') // ficus-p5-bridge
    expect(script).toContain('legacy_cluster_exists()')
    expect(script).toContain('warn_legacy_cluster_if_present()')
    // The exact migrate/delete commands name the legacy cluster via the
    // marked constant, not a retyped literal.
    expect(script).toMatch(/k3d cluster delete \$\{LEGACY_CLUSTER_NAME\}/)
    expect(script).toMatch(/rsync -a \$\{LEGACY_HOME\}/)
    // Wired into both the fresh-setup path and a routine status check —
    // not just one of the two places a developer would notice it.
    expect(script).toMatch(/cmd_setup\(\)[\s\S]*warn_legacy_cluster_if_present/)
    expect(script).toMatch(/cmd_status\(\)[\s\S]*warn_legacy_cluster_if_present/)
  })
})
