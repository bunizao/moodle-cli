from importlib.metadata import PackageNotFoundError

import moodle_cli.version as version_module


def test_get_version_uses_installed_package_version(monkeypatch):
    monkeypatch.setattr(version_module, "package_version", lambda _: "9.9.9")

    assert version_module.get_version() == "9.9.9"


def test_get_version_falls_back_to_local_version(monkeypatch):
    monkeypatch.setattr(version_module, "package_version", lambda _: (_ for _ in ()).throw(PackageNotFoundError))
    monkeypatch.setattr(version_module, "read_local_version", lambda: "1.2.3")

    assert version_module.get_version() == "1.2.3"
