"""Shared pytest configuration for the agent-approval-check unit tests.

``agent_approval_check.py`` is a stand-alone script (not a package), so its
directory is put on ``sys.path`` and it is imported as a plain module.
Importing it needs no environment variables and never runs ``main()``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent_approval_check as aac  # noqa: E402  (needs the sys.path entry above)
from tests.factories import AGENT_EMAIL  # noqa: E402


@pytest.fixture(autouse=True)
def _pin_required_approvals(monkeypatch: pytest.MonkeyPatch) -> None:
    """REQUIRED_APPROVALS is read from the environment at import time; pin it so
    expectations such as "2/2 approvals" don't depend on the runner's env."""
    monkeypatch.setattr(aac, "REQUIRED_APPROVALS", 2)


@pytest.fixture(autouse=True)
def _block_real_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """The script talks to GitHub through the module-level ``httpx.post`` and
    ``httpx.request`` helpers. Replace them with stubs that fail loudly; the
    client tests override them with an ``httpx.MockTransport``-backed client."""

    def _blocked(*_args: object, **_kwargs: object) -> None:
        raise AssertionError(
            "unexpected real HTTP call — route requests through the mock GitHub fixture"
        )

    monkeypatch.setattr(httpx, "post", _blocked)
    monkeypatch.setattr(httpx, "request", _blocked)


@pytest.fixture
def config() -> aac.AgentConfig:
    """Baseline identity config used across the suite (repo key ``o/r``)."""
    return aac.AgentConfig(
        agent_emails=[AGENT_EMAIL],
        agent_app_logins=["claude[bot]", "claude-code[bot]"],
        excluded_approver_logins=["rubber-stamp[bot]"],
        exempt_head_branches=[],
        exempt_path_prefixes={"o/r": ["docs/"]},
        protected_bases={"o/r": {"exact": ["main"], "prefixes": ["release/"]}},
    )
