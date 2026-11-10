#!/usr/bin/env python3
"""Generate a disposable, diagnostic-only source overlay; never ship it.

Outputs fixed refusal categories only, with no payloads, paths or credentials.
Fails if the exact candidate shape differs; no admission condition is changed.
"""
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text()
start = source.index('    async deliver<T>')
end = source.index('    async read(q:', start)
before, section, after = source[:start], source[start:end], source[end:]

def replace(old, new, expected=1):
    global section
    if section.count(old) != expected:
        raise SystemExit('diagnostic_anchor_mismatch')
    section = section.replace(old, new, 1)

replace('      expire();\n      if (!isSourceNodeDelivery(payload) || Date.now() >= payload.expires_at) return null;',
        '      expire();\n      if (!isSourceNodeDelivery(payload) || Date.now() >= payload.expires_at) { console.log("DELIVERY_DIAG payload_or_deadline"); return null; }')
replace('        || lease.q.mode !== "fork_independent") return null;',
        '        || lease.q.mode !== "fork_independent") { console.log("DELIVERY_DIAG lease_binding", JSON.stringify({present:!!lease, remaining: lease ? lease.q.expires_at-Date.now() : null})); return null; }')
replace('if (sourceExecutions.has(key)) return null;', 'if (sourceExecutions.has(key)) { console.log("DELIVERY_DIAG duplicate"); return null; }')
replace('if (p.fingerprint !== lease.fingerprint) return null;', 'if (p.fingerprint !== lease.fingerprint) { console.log("DELIVERY_DIAG fingerprint"); return null; }')
replace('if (privateRecord(join(p.nodeDir, "config.json")).flags?.opencodeUnsafeTools !== true) return null;', 'if (privateRecord(join(p.nodeDir, "config.json")).flags?.opencodeUnsafeTools !== true) { console.log("DELIVERY_DIAG unsafe_flag"); return null; }')
replace('if (h.generation === payload.session_id && h.serve?.pid === p.server.pid && live?.ticks === h.bridge?.ticks) return null;', 'if (h.generation === payload.session_id && h.serve?.pid === p.server.pid && live?.ticks === h.bridge?.ticks) { console.log("DELIVERY_DIAG existing_bridge"); return null; }')
replace('if (!active?.data || typeof active.data !== "object" || Array.isArray(active.data) || Object.hasOwn(active.data, payload.session_id)) return null;', 'if (!active?.data || typeof active.data !== "object" || Array.isArray(active.data) || Object.hasOwn(active.data, payload.session_id)) { console.log("DELIVERY_DIAG active"); return null; }')
replace('if (!await reader.recheck(task.evidence.lease_id) || Date.now() >= payload.expires_at) return null;', 'if (!await reader.recheck(task.evidence.lease_id) || Date.now() >= payload.expires_at) { console.log("DELIVERY_DIAG recheck_after_resume"); return null; }', expected=2)
replace('if (!catalog.defaultModel || catalog.defaultModel.providerId.includes("/")) return null;', 'if (!catalog.defaultModel || catalog.defaultModel.providerId.includes("/")) { console.log("DELIVERY_DIAG catalog_default"); return null; }')
replace('if (!await reader.recheck(task.evidence.lease_id) || Date.now() >= payload.expires_at) return null;', 'if (!await reader.recheck(task.evidence.lease_id) || Date.now() >= payload.expires_at) { console.log("DELIVERY_DIAG recheck_after_catalog"); return null; }')
replace('      } catch { return null; }', '      } catch { console.log("DELIVERY_DIAG caught"); return null; }')
pathlib.Path(sys.argv[2]).write_text(before + section + after)
