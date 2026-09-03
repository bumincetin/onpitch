"""OnPitch anomaly sidecar.

An advisory Isolation Forest service that scores match-integrity feature
vectors. The platform finalises matches whether or not this service answers --
see ``README.md`` and the failure-path note in ``docs/API.md``.

Nothing heavy is imported here on purpose: ``app.model`` and ``app.security``
must stay importable (and unit-testable) without pulling in FastAPI.
"""

from .config import SERVICE_NAME, SERVICE_VERSION
from .model import FALLBACK_MODEL_VERSION, FEATURE_ORDER, MODEL_VERSION

__all__ = [
    "SERVICE_NAME",
    "SERVICE_VERSION",
    "MODEL_VERSION",
    "FALLBACK_MODEL_VERSION",
    "FEATURE_ORDER",
]

__version__ = SERVICE_VERSION
