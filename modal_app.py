"""Deploy the AfriSpeech Listen synthesis service to Modal.

Self-contained: no Upstash dependencies. Runs synthesis in-process.
Secrets configured in Modal dashboard as `afrispeech-secrets`.
"""
import subprocess
import modal

app = modal.App("afrispeech-listen")

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
        ignore=["node_modules", ".git", "dist", ".env", ".env.*", "*.log", "__pycache__", "*.pyc"],
    )
    .run_commands("npm ci --omit=dev")
)

secrets = [modal.Secret.from_name("afrispeech-secrets")]

@app.function(
    image=image,
    secrets=secrets,
    cpu=2,
    memory=4096,
    min_containers=1,
    timeout=300,
)
@modal.web_server(port=8787, startup_timeout=120)
def entrypoint():
    subprocess.run(["node", "server.mjs"], cwd="/app", check=True)
