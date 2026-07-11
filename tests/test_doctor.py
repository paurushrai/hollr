from lib import doctor

ALL_BINARIES = {"python3", "say", "osascript", "afplay", "claude"}


def _which_factory(present: set[str]):
    def _which(name: str) -> str | None:
        return f"/usr/bin/{name}" if name in present else None

    return _which


def test_all_present_on_darwin_means_every_check_ok(monkeypatch):
    monkeypatch.setattr(doctor.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(doctor.shutil, "which", _which_factory(ALL_BINARIES))
    checks = doctor.check_all()
    assert all(c.ok for c in checks)
    assert doctor.all_required_ok(checks)


def test_missing_python3_fails_required_check_with_xcode_fix(monkeypatch):
    monkeypatch.setattr(doctor.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(doctor.shutil, "which", _which_factory(ALL_BINARIES - {"python3"}))
    checks = doctor.check_all()
    by_key = {c.key: c for c in checks}
    assert by_key["python3"].ok is False
    assert by_key["python3"].required is True
    assert "xcode-select" in by_key["python3"].fix
    assert doctor.all_required_ok(checks) is False


def test_non_darwin_fails_os_check_as_required_with_macos_only_detail(monkeypatch):
    monkeypatch.setattr(doctor.platform, "system", lambda: "Linux")
    monkeypatch.setattr(doctor.shutil, "which", _which_factory(ALL_BINARIES))
    checks = doctor.check_all()
    by_key = {c.key: c for c in checks}
    assert by_key["os"].ok is False
    assert by_key["os"].required is True
    assert "macOS" in by_key["os"].detail
    assert doctor.all_required_ok(checks) is False


def test_missing_afplay_does_not_fail_all_required_ok(monkeypatch):
    monkeypatch.setattr(doctor.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(doctor.shutil, "which", _which_factory(ALL_BINARIES - {"afplay"}))
    checks = doctor.check_all()
    by_key = {c.key: c for c in checks}
    assert by_key["afplay"].ok is False
    assert by_key["afplay"].required is False
    assert doctor.all_required_ok(checks) is True


def test_missing_claude_is_optional_with_docs_url_fix(monkeypatch):
    monkeypatch.setattr(doctor.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(doctor.shutil, "which", _which_factory(ALL_BINARIES - {"claude"}))
    checks = doctor.check_all()
    by_key = {c.key: c for c in checks}
    assert by_key["claude"].ok is False
    assert by_key["claude"].required is False
    assert "docs.claude.com" in by_key["claude"].fix
    assert doctor.all_required_ok(checks) is True


def test_nothing_present_never_raises_and_reports_all_required_failed(monkeypatch):
    monkeypatch.setattr(doctor.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(doctor.shutil, "which", _which_factory(set()))
    checks = doctor.check_all()  # must not raise
    assert doctor.all_required_ok(checks) is False
    required_keys = {c.key for c in checks if c.required}
    assert {"os", "python3", "say", "osascript"} <= required_keys
