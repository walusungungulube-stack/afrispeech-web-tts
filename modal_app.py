"""Deploy the AfriSpeech Listen synthesis service to Modal.

The service is self-contained: no Upstash dependency anywhere. Synthesis runs
in-process as a background task, run state and the audio cache live in memory
and expire on their own, and the rate limits are in-memory counters.

Secrets are NOT in this file and NOT in the image. They come from a Modal
secret named "afrispeech-secrets":

    modal secret create afrispeech-secrets --from-dotenv .env

Deploy:

    modal deploy modal_app.py

The URL it prints is permanent, and it is what the website points at:

    PUBLIC_LISTEN_ENDPOINT=https://<workspace>--afrispeech-listen-entrypoint.modal.run
"""
import subprocess

import modal

app = modal.App("afrispeech-listen")

# Node 22: debian_slim's own nodejs is too old for the fetch handler's
# Request/Response usage. The MP3 encoder is LAME in WebAssembly and encodes
# through the copy wasm-media-encoders carries, so nothing else is staged.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("curl", "ca-certificates")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
    )
    .workdir("/app")
    .add_local_dir(
        ".",
        remote_path="/app",
        # copy, not a mount: npm ci runs at build time, and a mounted directory
        # is not there yet, so the build fails with a missing package.json.
        copy=True,
        # The lockfile pins the encoder; node_modules is rebuilt from it.
        # .env must never be baked into an image: it carries the keys.
        ignore=["node_modules", ".git", "dist", ".env", ".env.*", "*.log", "__pycache__", "*.pyc"],
    )
    .run_commands("npm ci --omit=dev")
)

secrets = [modal.Secret.from_name("afrispeech-secrets")]


@app.function(
    image=image,
    secrets=secrets,
    # One core keeps up: the encoder is cheap, and the speech engines wait on
    # the model rather than on the CPU. One container stays warm, so the first
    # reader does not wait for a cold start.
    cpu=1,
    memory=4096,
    min_containers=1,
    timeout=300,
)
@modal.web_server(port=8787, startup_timeout=120)
def entrypoint():
    # Popen, not run: the server never exits, so a blocking call reads as an
    # initialization that never finishes and the container crash-loops.
    subprocess.Popen(["node", "server.mjs"], cwd="/app")
