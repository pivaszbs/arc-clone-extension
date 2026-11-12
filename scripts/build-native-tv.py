"""Build the Tizen 9.0 app and create an unsigned package."""

import os
from pathlib import Path
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
project = root / "tv" / "samsung-native"
stage = project / "bin" / "Release" / "net6.0" / "tpkroot"
output = root / "outputs" / "samsung-tv-native" / "AnimeStudy-0.1.0-unsigned.tpk"
dotnet = os.environ.get("ANIME_STUDY_DOTNET", "dotnet")

subprocess.run([
    dotnet, "msbuild", str(project / "AnimeStudy.csproj"), "-restore",
    "-target:Build,TizenResolveTpkPackageFiles,_TizenPrepareTpkPackage",
    "-property:Configuration=Release",
], check=True, cwd=root)
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(stage.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(stage))
print(output)
