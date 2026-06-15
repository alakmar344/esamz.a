# Rust Backend Streaming Whitespace Fix

This directory contains the fixes for the streaming whitespace loss bug in the
`esamz-backend/backend_for_esamzai` Rust backend (SSE streaming pipeline).

## How to Apply

From the root of `backend_for_esamzai`:

```bash
git am < rust_streaming_whitespace_fix.patch
```

Or apply individual patches:

```bash
# Fix 1: stream_sarvam() holdback zone
git apply rust_stream_sarvam_holdback_fix.patch

# Fix 2: send_event() escape ordering
git apply rust_send_event_fix.patch

# Fix 3: run_request() chunk reassembly
git apply rust_run_request_reassembly_fix.patch
```

## Reference File

`main.rs.fixed` is the complete fixed version of `src/main.rs` with all three patches applied.

## Bug Summary

1. **stream_sarvam() holdback zone** — `.map(|i| i + 1)` included the space
   in the SENT chunk, leaving the remainder buffer starting AFTER the space.
   Changed to `.map(|i| i)` so the space stays with the following word.

2. **send_event() escape ordering** — Backslashes were not escaped before
   newline escaping, causing ambiguity. Added `.replace('\\', "\\\\")` before
   `.replace('\n', "\\n")`.

3. **run_request() chunk reassembly** — Only un-escaped `\n` → newline but
   did not un-escape `\\` → `\`, so literal backslashes were doubled.
   Added `.replace("\\\\", "\\")` after the newline un-escape.
