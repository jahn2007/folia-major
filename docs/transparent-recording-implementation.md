# Transparent live recording — implementation status

This branch targets a **single Chromium lyric animation renderer** whose completed
transparent frames are distributed to both the player compositor and the live video
encoder. Display and recording must never run separate copies of the animation.

## Product requirements

- Real-time Start, Stop & Save, Cancel; capture no other desktop windows.
- Transparent VP9/WebM, HEVC/MOV, and QuickTime Animation/MOV.
- Prefer an encoder proved to preserve the alpha channel on the chosen GPU.
- When unavailable, use an alpha-preserving software backend for the same codec.
- Allow separate selection of rendering GPU (subject to platform limitations) and
  encoding GPU (per device ID), and make the effective backend visible in UI.
- Do not block playback on encoder backpressure. Maintain timestamp-based CFR output.
- Preserve playback, style transitions, audio-reactive effects, Folium layers.
- All application binaries built by GitHub Actions and uploaded to this fork's Releases.

## Current branch state

The branch currently provides:

1. `electron/recording/encoderCapabilities.cjs`: a constrained backend registry
   and an end-to-end encode/decode alpha capability probe. Hardware backends are
   *not* declared for ordinary NVENC/QSV/AMF HEVC or VP9 because generic codec
   support does not imply alpha support.
2. `test/unit/electron/encoderCapabilities.test.ts`: selection, CPU fallback,
   device filtering and source-frame unit tests.
3. `electron/recording/probe/{app,preload}.cjs`: a minimal Electron shared-GPU-
   texture transfer/display proof-of-concept. Run with
   `npx electron electron/recording/probe/app.cjs` on a machine with a GPU.
   The probe must succeed on target systems before migrating the player renderer.
4. `.github/workflows/transparent-recording-preview.yml`: fork-local preview
   packaging for Windows, Linux and macOS, uploading successful binaries to
   pre-releases using the fork's `GITHUB_TOKEN`. No local toolchain is required.

**This is NOT a completed recording feature.** The preview binaries only contain
the experimental support files; the live recording controls, final shared-texture
presenter, and live encoder pipeline have not yet been integrated into the app.
Successful package compilation is not equivalent to validated GPU behavior.

## Remaining implementation gates

A. Shared-texture transfer proof on Windows (primary target), macOS and Linux:
   alpha tests, CPU/GPU import lifetime, WebGPU display compatibility.
B. Refactor `VisualizerRenderer` and its backdrop layer contract so the full
   visualizer frontend renders just once in a persistent transparent surface.
   Build the primary-window presenter with proper sizing, input forwarding and
   clock/audio/transition synchronization.
C. Implement timestamped frame fan-out, a bounded recording queue, frame-rate
   conversion, ffmpeg process management and crash-safe file finalization.
D. Integrate UI, per-GPU selection, capability probing, three alpha formats and
   software fallback. Bundle suitable FFmpeg; audit libx265 redistribution terms.
E. Add automated regression tests, real-machine recordings, alpha verifications
   and release integrity checks. Only declare production completion when these
   pass.

## Release workflow

Pushing to `feat/transparent-live-recording` runs the preview workflow.
Each successful build generates a separate prerelease on this fork, not on the
upstream `chthollyphile/folia-major` repository.

Unsigned packages may require OS-specific user approval. The pipeline avoids
assuming preconfigured macOS signing or Windows code signing.
