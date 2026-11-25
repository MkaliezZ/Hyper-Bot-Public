"""Create a pinned, unpacked Hyper Bot Windows x64 engineering package."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
from zipfile import BadZipFile, ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
ELECTRON = ("41.0.2", "dcd36396a606a5ae2f5651b4ee6bb463a624dbf15f786eda57cee2cc361c138c")
NODE = ("25.8.1", "09a5a0dbb2f4cefa800880012810e2dfaac0016a62e75f064c4ab7f3606b2d78")
NODE_EXE_SHA = "8ccfc9b16942fd1f4154e160a249805dd88eb0d253b789aa669b91cf0ade6e57"
COPY_DIRS = ("desktop", "server", "dist", "public", "skills")
SCRIPTS = ("doctor.mjs", "workspace.mjs", "hermes_acp.py", "workbench_server.py")
NOTICE = re.compile(r"^(licen[cs]e|licensing|copying|notice)([._ -]|$)", re.I)
FILE_MANIFEST = "包内文件摘要.json"
WINDOWS_MARK = "public/media/mark.png"
DSH_VERSION = "0.2.2-rc.1"
# Hyper Bot starts the pinned sdk-minimal profile and sends authorized text over
# its private API. These other profiles and media engines are not entry points.
TEXT_PROFILE_EXCLUSIONS = {
    "@deepseek-ai/dsh-web-app": (DSH_VERSION, "Hyper Bot renders its own web client"),
    "@deepseek-ai/dsh-llm-pi-ai": (DSH_VERSION, "Both transports use the sdk-minimal DeepSeek provider"),
    "@deepseek-ai/dsh-experimental-inspector-profile": (DSH_VERSION, "Neither text transport mounts the inspector profile"),
    "@deepseek-ai/dsh-web-frontend": (DSH_VERSION, "Hyper Bot renders its own web client"),
    "@deepseek-ai/dsh-office-to-pdf": (DSH_VERSION, "Office conversion is outside the text input contract"),
    "@deepseek-ai/dsh-skill-office": (DSH_VERSION, "Office conversion is outside the text input contract"),
    "@deepseek-ai/libreoffice-kit": ("0.1.5", "Office conversion is outside the text input contract"),
    "@deepseek-ai/libreoffice-kit-win32-x64": ("0.1.5", "Office conversion is outside the text input contract"),
    "@deepseek-ai/dsh-experimental-speech-to-text": (DSH_VERSION, "The release accepts TXT and Markdown"),
    "@deepseek-ai/dsh-experimental-speech-to-text-sensevoice": (DSH_VERSION, "The release accepts TXT and Markdown"),
    "@deepseek-ai/dsh-experimental-voice-input-bundle": (DSH_VERSION, "The release accepts TXT and Markdown"),
    "sherpa-onnx-node": ("1.13.8", "The release accepts TXT and Markdown"),
    "sherpa-onnx-win-x64": ("1.13.8", "The release accepts TXT and Markdown"),
    "@img/sharp-win32-x64": ("0.35.5", "Raster transforms are lazy and outside the text input contract"),
    "@img/sharp-wasm32": ("0.35.5", "Raster transforms are lazy and outside the text input contract"),
    "@img/sharp-freebsd-wasm32": ("0.35.5", "The release targets Windows x64 and accepts text"),
    "@img/sharp-webcontainers-wasm32": ("0.35.5", "The release targets Windows x64 and accepts text"),
}


def sha256(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def load_json(file):
    return json.loads(file.read_text(encoding="utf-8"))


def write_json(file, value):
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def verified_zip(file, expected):
    if not file.is_file() or sha256(file) != expected:
        raise ValueError(f"归档摘要不符 {file.name}")
    return ZipFile(file)


def relative(name):
    parts = name.rstrip("/").split("/")
    if not all(part and part not in (".", "..") and "\\" not in part and ":" not in part for part in parts):
        raise ValueError(f"归档路径无效 {name}")
    return PurePosixPath(*parts)


def extract(archive, entry, target):
    if stat.S_ISLNK(entry.external_attr >> 16):
        raise ValueError(f"归档路径类型无效 {entry.filename}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with archive.open(entry) as source, target.open("xb") as sink:
        shutil.copyfileobj(source, sink)


def ignore_nested(folder, names):
    for name in names:
        file = Path(folder) / name
        if file.is_symlink() or file.is_junction():
            raise ValueError(f"依赖含有未支持的链接 {file}")
    return {"node_modules"} & set(names)


def package_files(folder):
    for current, directories, files in os.walk(folder):
        directories[:] = sorted(name for name in directories if name != "node_modules")
        for name in sorted(files):
            yield Path(current) / name


def receipt(file, base):
    return {"path": file.relative_to(base).as_posix(), "bytes": file.stat().st_size, "sha256": sha256(file)}


def reachable_packages(lock, excluded):
    pending = [""]
    reached = set()
    while pending:
        name = pending.pop()
        if name in reached or name in excluded:
            continue
        reached.add(name)
        record = lock[name]
        dependencies = record.get("dependencies", {}) | record.get("optionalDependencies", {}) | record.get("peerDependencies", {})
        package = PurePosixPath(name)
        search = [package / "node_modules"]
        search.extend(parent for parent in package.parents if parent.name == "node_modules")
        for dependency in dependencies:
            candidates = ((folder / dependency).as_posix() for folder in search)
            resolved = next((candidate for candidate in candidates if candidate in lock), None)
            if resolved:
                pending.append(resolved)
    return reached


def runtime_exclusions(lock):
    excluded = {}
    for name, record in sorted(lock.items()):
        if not name or record.get("dev"):
            continue
        rel = relative(name)
        if rel.parts[0] != "node_modules" or record.get("link"):
            raise ValueError(f"发布依赖必须有固定版本 {name}")
        package = record.get("name") or name.rsplit("node_modules/", 1)[-1]
        rule = TEXT_PROFILE_EXCLUSIONS.get(package)
        parent = next((ancestor for ancestor in rel.parents if ancestor.as_posix() in excluded), None)
        if rule:
            if record["version"] != rule[0]:
                raise ValueError(f"需重新核查文本发行文件排除规则 {name}")
            excluded[name] = rule[1]
        elif parent:
            excluded[name] = f"Nested dependency of excluded package {parent.as_posix()}"

    # npm hoists some dependencies outside the owning package's directory.
    # Keep shared packages. Remove a hoisted package only when every locked
    # runtime path to it goes through an explicitly excluded branch.
    runtime_lock = {name: record for name, record in lock.items() if not record.get("dev")}
    before = reachable_packages(runtime_lock, {})
    after = reachable_packages(runtime_lock, excluded)
    for name in before - after:
        excluded.setdefault(name, "Only reachable through excluded profile dependencies")
    return excluded


def dependencies(source, install, output):
    lock = load_json(source / "package-lock.json")["packages"]
    excluded_paths = runtime_exclusions(lock)
    inventory = []
    omitted = []
    excluded = []
    for name, record in sorted(lock.items()):
        if not name or record.get("dev"):
            continue
        rel = relative(name)
        original = install / rel
        if not original.exists() and record.get("optional"):
            omitted.append(name)
            continue
        if original.is_symlink() or original.is_junction():
            raise ValueError(f"发布依赖含有未支持的链接 {name}")
        meta = load_json(original / "package.json")
        if meta["version"] != record.get("version"):
            raise ValueError(f"已安装依赖与锁定版本不一致 {name}")
        row = {
            "path": name, "package": meta["name"], "version": meta["version"], "license": meta.get("license"),
            "resolved": record.get("resolved"), "integrity": record.get("integrity"),
        }
        reason = excluded_paths.get(name)
        if reason:
            excluded.append({**row, "reason": reason, "bytes": sum(p.stat().st_size for p in package_files(original))})
            continue

        target = output / rel
        shutil.copytree(original, target, dirs_exist_ok=True, ignore=ignore_nested)
        notices = [receipt(p, output) for p in package_files(target) if NOTICE.match(p.name)]
        inventory.append({**row, "notices": [PurePosixPath(p["path"]).relative_to(rel).as_posix() for p in notices],
                          "noticeFiles": notices})
    return {"packages": inventory, "optionalNotInstalled": omitted, "excludedByProfile": excluded}


def supplement_notices(source, folder, inventory):
    originals = source / "docs" / "第三方许可补充"
    index = originals / "来源清单.json"
    if not index.is_file():
        return
    definitions = load_json(index)
    if definitions["schema"] != 1:
        raise ValueError("补充许可索引的版本不受支持。")
    by_lock = {(row["package"], row["version"], row["integrity"]): row for row in definitions["packages"]}
    for package in inventory["packages"]:
        key = (package["package"], package["version"], package["integrity"])
        entry = by_lock.get(key)
        if not entry or package["noticeFiles"]:
            continue
        copied = []
        for row in entry["files"]:
            filename = relative(row["path"])
            if len(filename.parts) != 1 or not row["source"].startswith("https://"):
                raise ValueError("补充许可的文件名或来源无效。")
            origin = originals / filename
            if sha256(origin) != row["sha256"]:
                raise ValueError(f"补充许可原件摘要不符 {filename}")
            destination = folder / "第三方许可补充" / filename
            destination.parent.mkdir(exist_ok=True)
            if not destination.exists():
                shutil.copy2(origin, destination)
            elif sha256(destination) != row["sha256"]:
                raise ValueError(f"补充许可原件重名 {filename}")
            copied.append({**receipt(destination, folder), "source": row["source"], "commit": entry["commit"],
                           "verifiedBy": entry["verifiedBy"]})
        package["supplementalNotices"] = copied


def seal(folder, manifest=FILE_MANIFEST):
    folder = folder.resolve()
    if not (folder / manifest).is_file():
        raise ValueError("缺少待封装目录的文件摘要。")
    destination = folder.parent / (folder.name + ".zip")
    with ZipFile(destination, "x", compression=ZIP_DEFLATED, compresslevel=4) as archive:
        for member in sorted(folder.rglob("*")):
            if member.is_file():
                archive.write(member, member.relative_to(folder.parent).as_posix())
    digest = sha256(destination)
    destination.with_suffix(".zip.sha256").write_text(digest + "  " + destination.name + "\n", encoding="utf-8")
    return destination


def zip_members(archive):
    members = [(relative(info.filename), info) for info in archive.infolist() if not info.is_dir()]
    roots = {name.parts[0] for name, _ in members}
    if len(roots) != 1 or any(len(name.parts) < 2 for name, _ in members):
        raise ValueError("ZIP 必须包含一个独立的应用目录。")
    mapped = {PurePosixPath(*name.parts[1:]).as_posix(): info for name, info in members}
    if len({name.casefold() for name in mapped}) != len(members):
        raise ValueError("ZIP 含有重复的 Windows 文件路径。")
    return roots.pop(), mapped


def verify_files(archive, members, manifest):
    if manifest["schema"] != 1:
        raise ValueError("文件摘要版本不受支持。")
    indexed = {row["path"]: row for row in manifest["files"]}
    if len(indexed) != len(manifest["files"]) or set(indexed) != set(members) - {FILE_MANIFEST}:
        raise ValueError("实际文件与文件摘要的清单不同。")
    for name, row in indexed.items():
        info = members[name]
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ValueError(f"ZIP 含有链接 {name}")
        with archive.open(info) as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != row["sha256"] or info.file_size != row["bytes"]:
            raise ValueError(f"包内文件摘要不符 {name}")
    return indexed


def npm_root(name):
    parts = name.split("/")
    if parts[:3] != ["resources", "app", "node_modules"] or parts[-1] != "package.json":
        return None
    split = max(i for i, part in enumerate(parts) if part == "node_modules")
    tail = parts[split + 1:-1]
    if len(tail) == 1 or (len(tail) == 2 and tail[0].startswith("@")):
        return "/".join(parts[2:-1])
    return None


def verify_packages(read, members, indexed, metadata):
    inventory = read(metadata["npmInventory"])
    lock_path = "resources/app/package-lock.json"
    if indexed[lock_path]["sha256"] != metadata["packageLockSha256"]:
        raise ValueError("锁文件摘要与发布清单不一致。")
    lock = read(lock_path)["packages"]
    actual = {root for name in members if (root := npm_root(name))}
    rows = inventory["packages"]
    advertised = {row["path"] for row in rows}
    excluded = inventory["excludedByProfile"]
    excluded_paths = {row["path"] for row in excluded}
    optional = set(inventory["optionalNotInstalled"])
    required = {name for name, row in lock.items() if name and not row.get("dev")}
    if actual != advertised or len(advertised) != len(rows) or len(rows) != metadata["npmPackageCount"]:
        raise ValueError("ZIP 中的 npm 组件与清单不同。")
    if required != advertised | excluded_paths | optional or len(required) != len(rows) + len(excluded) + len(optional):
        raise ValueError("运行时锁定组件的安装和排除记录不全。")
    if any(not lock[name].get("optional") for name in optional):
        raise ValueError("缺少锁定的必需 npm 组件。")
    if len(excluded) != metadata["excludedPackageCount"] or sum(row["bytes"] for row in excluded) != metadata["excludedPackageBytes"]:
        raise ValueError("文本运行时排除记录与发布清单不同。")
    component_paths = {name.removeprefix("resources/app/") for name in members if name.startswith("resources/app/node_modules/")}
    for row in rows + excluded:
        name = row["path"]
        if any(row[key] != lock[name].get(key) for key in ("version", "resolved", "integrity")):
            raise ValueError(f"组件源头与锁文件不一致 {name}")
        if name in excluded_paths:
            if any(path.startswith(name + "/") for path in component_paths):
                raise ValueError(f"排除的组件出现在 ZIP 中 {name}")
            continue
        package = read(f"resources/app/{name}/package.json")
        if (package["name"], package["version"], package.get("license")) != (row["package"], row["version"], row["license"]):
            raise ValueError(f"包内组件的元数据不一致 {name}")
        for notice in row["noticeFiles"]:
            path = "resources/app/" + notice["path"]
            if not notice["path"].startswith(name + "/") or indexed[path]["sha256"] != notice["sha256"] or indexed[path]["bytes"] != notice["bytes"]:
                raise ValueError(f"组件的许可文件摘要不一致 {name}")
        for notice in row.get("supplementalNotices", []):
            path = notice["path"]
            if (not path.startswith("第三方许可补充/") or indexed[path]["sha256"] != notice["sha256"]
                    or indexed[path]["bytes"] != notice["bytes"] or not notice["source"].startswith("https://")
                    or not re.fullmatch(r"[0-9a-f]{40}", notice["commit"])):
                raise ValueError(f"补充许可的文件摘要或来源不一致 {name}")
    if [row["path"] for row in rows if not row["license"]] != metadata["missingDeclaredLicense"]:
        raise ValueError("组件许可声明与发布清单不一致。")
    source_gaps = [row["path"] for row in rows if not row["noticeFiles"]]
    gaps = [row["path"] for row in rows if not row["noticeFiles"] and not row.get("supplementalNotices")]
    supplemented = sum(bool(row.get("supplementalNotices")) for row in rows)
    if (source_gaps != metadata["packagesWithoutNoticeFiles"] or gaps != metadata["packagesWithoutNoticeEvidence"]
            or supplemented != metadata["supplementedPackageCount"]):
        raise ValueError("许可原件索引与发布清单不一致。")
    return inventory, gaps


def verify(candidate):
    candidate = candidate.resolve()
    digest = sha256(candidate)
    declared = candidate.with_suffix(".zip.sha256").read_text(encoding="utf-8").split()
    if not declared or digest != declared[0]:
        raise ValueError("Windows ZIP 与伴随的 SHA-256 摘要不符。")
    with ZipFile(candidate) as archive:
        root, members = zip_members(archive)

        def read(name):
            if name not in members:
                raise ValueError(f"ZIP 缺少 {name}")
            return json.loads(archive.read(members[name]))

        metadata = read("发布候选清单.json")
        if (root != f"Hyper Bot {metadata['version']} win-x64" or metadata["runtimeProfile"] != "sdk-minimal-text"
                or (metadata["product"], metadata["platform"], metadata["fileManifest"]) != ("Hyper Bot", "win32-x64", FILE_MANIFEST)):
            raise ValueError("ZIP 目录或运行时清单无效。")
        app = read("resources/app/package.json")
        if (app["productName"], app["version"]) != (metadata["product"], metadata["version"]):
            raise ValueError("应用名称或版本信息与 ZIP 不一致。")
        indexed = verify_files(archive, members, read(FILE_MANIFEST))
        inventory, gaps = verify_packages(read, members, indexed, metadata)
        identity = metadata.get("windowsIdentity")
        if identity is not None and (
            (identity["product"], identity["version"]) != (metadata["product"], metadata["version"])
            or identity["executableSha256"] != indexed["Hyper Bot.exe"]["sha256"]
            or identity["markSha256"] != indexed[f"resources/app/{WINDOWS_MARK}"]["sha256"]
            or not re.fullmatch(r"[0-9a-f]{64}", identity["electronExecutableSha256"])
            or identity["executableSha256"] == identity["electronExecutableSha256"]
        ):
            raise ValueError("Windows 应用标识与归档内容不一致。")
        if indexed["resources/node/node.exe"]["sha256"] != metadata["node"]["executableSha256"]:
            raise ValueError("Node 可执行文件摘要不符。")
        for name in metadata["electron"]["notices"] + metadata["node"]["notices"]:
            if name not in indexed:
                raise ValueError(f"ZIP 缺少运行时许可文件 {name}")
        return {
            "version": metadata["version"], "archiveBytes": candidate.stat().st_size, "archiveSha256": digest,
            "verifiedFiles": len(indexed), "indexedNpmPackages": len(inventory["packages"]),
            "excludedPackageCount": metadata["excludedPackageCount"], "excludedPackageBytes": metadata["excludedPackageBytes"],
            "excludedPackages": [p["package"] for p in inventory["excludedByProfile"]],
            "missingDeclaredLicense": metadata["missingDeclaredLicense"],
            "packagesWithoutNoticeFiles": metadata["packagesWithoutNoticeFiles"], "packagesWithoutNoticeEvidence": gaps,
            "supplementedPackageCount": metadata["supplementedPackageCount"],
            "packageLockSha256": metadata["packageLockSha256"], "runtimeProfile": metadata["runtimeProfile"],
            "externalComponents": metadata["externalComponents"],
            **({"windowsIdentity": identity} if identity is not None else {}),
        }


def assemble(args):
    source = args.source.resolve()
    package = load_json(source / "package.json")
    locked = load_json(source / "package-lock.json")["packages"][""]
    version = package["version"]
    if locked["version"] != version or locked["devDependencies"]["electron"] != ELECTRON[0]:
        raise ValueError("发行版本和 Electron 清单须与锁文件一致。")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?", version):
        raise ValueError("应用版本号无效。")
    build_node = shutil.which("node")
    editor = source / "node_modules/resedit/package.json"
    if not build_node or not editor.is_file() or load_json(editor)["version"] != locked["devDependencies"]["resedit"]:
        raise ValueError("构建需要 Node 与锁定的 resedit。请先在源码目录执行 npm ci。")
    base = f"Hyper Bot {version} win-x64"
    output = args.output.resolve()
    folder = output / base
    destination = output / f"{base}.zip"
    if folder.exists() or destination.exists():
        raise FileExistsError(f"发布候选已存在 {base}")

    with verified_zip(args.electron_zip, ELECTRON[1]) as electron, verified_zip(args.node_zip, NODE[1]) as node:
        folder.mkdir(parents=True)
        for entry in electron.infolist():
            rel = relative(entry.filename)
            if entry.is_dir() or entry.filename == "resources/default_app.asar":
                continue
            extract(electron, entry, folder / ("Hyper Bot.exe" if entry.filename == "electron.exe" else rel))
        node_destination = folder / "resources/node"
        prefix = f"node-v{NODE[0]}-win-x64/"
        for file in ("node.exe", "LICENSE"):
            extract(node, node.getinfo(prefix+file), node_destination / file)
        if sha256(node_destination / "node.exe") != NODE_EXE_SHA:
            raise ValueError("Node 可执行文件摘要不符。")

    executable = folder / "Hyper Bot.exe"
    electron_executable_sha = sha256(executable)
    mark = source / WINDOWS_MARK
    branding = subprocess.run(
        [build_node, str(source / "scripts/brand-windows-exe.mjs"), str(executable), str(mark),
         package["productName"], version],
        capture_output=True, encoding="utf-8", timeout=60, check=False,
    )
    if branding.returncode:
        raise ValueError(f"Windows 应用标识写入失败 {branding.stderr.strip()}")

    app = folder / "resources/app"
    app.mkdir()
    for name in COPY_DIRS:
        # Standalone browser development entry point belongs to the source checkout.
        ignore = shutil.ignore_patterns("index.mjs") if name == "server" else None
        shutil.copytree(source / name, app / name, ignore=ignore)
    for name in SCRIPTS:
        dest = app / "scripts" / name
        dest.parent.mkdir(exist_ok=True)
        shutil.copy2(source / dest.relative_to(app), dest)
    app_package = {key: package[key] for key in ("name", "productName", "version", "type", "private")}
    write_json(app / "package.json", {**app_package, "main": "desktop/main.mjs"})
    shutil.copy2(source / "package-lock.json", app / "package-lock.json")
    inventory = dependencies(source, args.install.resolve(), app)
    supplement_notices(source, folder, inventory)
    shutil.copy2(ROOT / "docs/Windows 测试包使用.md", folder / "使用说明.md")
    shutil.copy2(ROOT / "scripts/Hyper Bot 维护.cmd", folder / "Hyper Bot 维护.cmd")
    metadata = {
        "product": package["productName"], "version": version, "platform": "win32-x64", "stage": "local-engineering-test",
        "electron": {"version": ELECTRON[0], "archiveSha256": ELECTRON[1], "notices": ["LICENSE", "LICENSES.chromium.html"]},
        "windowsIdentity": {"product": package["productName"], "version": version,
                            "executableSha256": sha256(executable), "markSha256": sha256(mark),
                            "electronExecutableSha256": electron_executable_sha},
        "node": {"version": NODE[0], "archiveSha256": NODE[1], "executableSha256": NODE_EXE_SHA, "notices": ["resources/node/LICENSE"]},
        "packageLockSha256": sha256(source / "package-lock.json"),
        "npmInventory": "npm-组件清单.json",
        "npmPackageCount": len(inventory["packages"]),
        "missingDeclaredLicense": [p["path"] for p in inventory["packages"] if not p["license"]],
        "packagesWithoutNoticeFiles": [p["path"] for p in inventory["packages"] if not p["noticeFiles"]],
        "packagesWithoutNoticeEvidence": [p["path"] for p in inventory["packages"]
                                         if not (p["noticeFiles"] or p.get("supplementalNotices"))],
        "supplementedPackageCount": sum(bool(p.get("supplementalNotices")) for p in inventory["packages"]),
        "runtimeProfile": "sdk-minimal-text",
        "desktopCredentialSetup": (source / "desktop/credentials.mjs").is_file(),
        "desktopRuntimeSetup": (source / "desktop/runtime-installations.mjs").is_file(),
        "excludedPackageCount": len(inventory["excludedByProfile"]),
        "excludedPackageBytes": sum(p["bytes"] for p in inventory["excludedByProfile"]),
        "fileManifest": FILE_MANIFEST,
        "externalComponents": ["Self Media Workbench", "Hermes ACP", "DeepSeek provider"],
    }
    write_json(folder / "发布候选清单.json", metadata)
    write_json(folder / "npm-组件清单.json", inventory)
    files = sorted(file for file in folder.rglob("*") if file.is_file())
    write_json(folder / FILE_MANIFEST, {"schema": 1, "files": [receipt(file, folder) for file in files]})
    if not args.unpack_only:
        seal(folder)
    return {"version": version, "folder": str(folder), "zip": str(destination) if not args.unpack_only else None,
            "packageCount": metadata["npmPackageCount"], "licenseMetadataGaps": len(metadata["missingDeclaredLicense"]),
            "noticeFileGaps": len(metadata["packagesWithoutNoticeEvidence"]),
            "supplementedPackageCount": metadata["supplementedPackageCount"],
            "excludedPackageCount": metadata["excludedPackageCount"], "excludedPackageBytes": metadata["excludedPackageBytes"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT)
    parser.add_argument("--install", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "release")
    parser.add_argument("--electron-zip", type=Path)
    parser.add_argument("--node-zip", type=Path)
    parser.add_argument("--unpack-only", action="store_true")
    parser.add_argument("--verify", type=Path, metavar="ZIP")
    arguments = parser.parse_args()
    try:
        if arguments.verify:
            result = verify(arguments.verify)
        else:
            if not arguments.electron_zip or not arguments.node_zip:
                parser.error("构建需要 --electron-zip 和 --node-zip。")
            result = assemble(arguments)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, KeyError, BadZipFile, subprocess.TimeoutExpired) as error:
        print(f"测试包构建失败 {error}", file=sys.stderr)
        sys.exit(1)

