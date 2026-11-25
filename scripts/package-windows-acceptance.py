"""Build the offline Windows target test kit from verified local release artifacts."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import runpy
import shutil
import sqlite3
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
PACK = runpy.run_path(str(ROOT / "scripts/package-windows.py"))
INDEX = "验收清单.json"
TEST_SCRIPTS = ("test-windows-target.mjs", "test-windows-package.mjs", "probe-dsh-web.mjs", "test-dsh-start-retry.mjs", "integration.mjs",
                "test-run-stop.mjs", "test-artifact-export.mjs", "test-generation-recovery.mjs",
                "test-skill-revocation.mjs", "test-provider-setup.mjs", "test-runtime-setup.mjs", "test-domain-workflow.mjs",
                "test-approval-revision.mjs")
WORKBENCH_PATHS = ("workbench/projects/", "workbench/sessions/", "workbench/task-requests/")
PLAYWRIGHT_VERSION = "1.62.1"


def fingerprint(file):
    verified = PACK["verify"](file)
    folder = f"Hyper Bot {verified['version']} win-x64"
    with ZipFile(file) as bundle:
        file_manifest = bundle.read(f"{folder}/{PACK['FILE_MANIFEST']}")
        release = json.loads(bundle.read(f"{folder}/发布候选清单.json"))
        workspace_cleanup = f"{folder}/resources/app/server/workspace-retirement.mjs" in bundle.namelist()
        window_access = f"{folder}/resources/app/server/window-session.mjs" in bundle.namelist()
        domain_workflow = f"{folder}/resources/app/server/workbench-workflow.mjs" in bundle.namelist()
        dsh_startup_recovery = b"'runtime_start_retry'" in bundle.read(f"{folder}/resources/app/server/application.mjs")
    return {
        "version": verified["version"], "folder": folder, "name": file.name, "bytes": verified["archiveBytes"],
        "sha256": verified["archiveSha256"], "files": verified["verifiedFiles"],
        "fileManifestSha256": hashlib.sha256(file_manifest).hexdigest(),
        "windowsIdentity": verified.get("windowsIdentity"),
        "workspaceCleanup": workspace_cleanup, "windowAccess": window_access,
        "desktopCredentialSetup": release.get("desktopCredentialSetup", False),
        "desktopRuntimeSetup": release.get("desktopRuntimeSetup", False), "domainWorkflow": domain_workflow,
        "dshStartupRecovery": dsh_startup_recovery,
    }, release["node"]["executableSha256"]


def copy_fixture(source, target):
    source = source.resolve()
    manifest = PACK["load_json"](source / "manifest.json")
    if manifest["format"] != "hyper-bot-workspace/1":
        raise ValueError("验收种子须为 Hyper Bot 工作区备份。")
    with closing(sqlite3.connect((source / "hyper-bot.sqlite").as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        state = json.loads(db.execute("SELECT body FROM workspace WHERE key=1").fetchone()[0])
    rooms = sorted(room["botId"] for room in state["conversations"])
    versions = sorted(row["version"] for row in state["artifacts"] if row["kind"] == "script")
    if (rooms != ["brief", "media"] or versions != [1, 2] or len(state["artifacts"]) != 3
            or any(not room.get("simulation") or room.get("original") for room in state["conversations"])):
        raise ValueError("验收种子须包含隔离合成口播两版与简报一版。")
    for row in manifest["files"]:
        name = row["path"]
        relative = PACK["relative"](name)
        if name != "hyper-bot.sqlite" and not name.startswith(WORKBENCH_PATHS):
            raise ValueError(f"验收种子文件不在工作区备份范围 {name}")
        origin = source / relative
        if (not origin.is_file() or origin.is_symlink() or origin.resolve() != origin
                or origin.stat().st_size != row["bytes"] or PACK["sha256"](origin) != row["sha256"]):
            raise ValueError(f"验收种子文件与备份清单不符 {name}")
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origin, destination)
    shutil.copy2(source / "manifest.json", target / "manifest.json")
    return {"format":manifest["format"],"appVersion":manifest["appVersion"],
            "syntheticConversations":len(rooms),"files":len(manifest["files"])}


def package(args):
    candidate, node_executable_sha = fingerprint(args.candidate)
    previous, _ = fingerprint(args.previous)
    if candidate["version"] == previous["version"]:
        raise ValueError("升级与回滚需要两个不同版本。")
    folder = args.output.resolve() / f"Hyper Bot {candidate['version']} Windows 验收工具"
    folder.mkdir(parents=True)
    scripts = folder / "scripts"
    scripts.mkdir()
    for filename in TEST_SCRIPTS:
        shutil.copy2(ROOT / "scripts" / filename, scripts / filename)
    (folder / "test").mkdir()
    for filename in ("model-fixture.mjs", "native-api.mjs", "isolated-workbench.mjs"):
        shutil.copy2(ROOT / "test" / filename, folder / "test" / filename)
    shutil.copy2(ROOT / "docs" / "Windows 11 验收.md", folder / "验收说明.md")

    fixture = copy_fixture(args.fixture, folder / "fixture")
    dependency_index = PACK["dependencies"](args.playwright_install, args.playwright_install, folder)
    installed = sorted((row["package"],row["version"]) for row in dependency_index["packages"])
    expected = [("playwright",PLAYWRIGHT_VERSION),("playwright-core",PLAYWRIGHT_VERSION)]
    if installed != expected or any(row["license"] != "Apache-2.0" or
            not all(name in row["notices"] for name in ("LICENSE","NOTICE"))
            for row in dependency_index["packages"]):
        raise ValueError("验收工具须使用固定 Playwright 版本并保留许可原件。")
    shutil.copy2(args.playwright_install / "package-lock.json", folder / "验收依赖锁.json")
    PACK["write_json"](folder / "验收依赖清单.json", dependency_index)
    files = sorted(file for file in folder.rglob("*") if file.is_file())
    PACK["write_json"](folder / INDEX, {"schema":1,"candidate":candidate,"previous":previous,
        "nodeExeSha256":node_executable_sha,"fixture":fixture,"files":[PACK["receipt"](file,folder) for file in files]})
    artifact = PACK["seal"](folder, INDEX)
    return {"archive":str(artifact),"bytes":artifact.stat().st_size,"sha256":PACK["sha256"](artifact),
            "manifestSha256":PACK["sha256"](folder / INDEX),"sourceVersion":candidate["version"],
            "archivedFiles":len(files)+1,"fixtures":fixture}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--playwright-install", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "release")
    print(json.dumps(package(parser.parse_args()), ensure_ascii=False))

