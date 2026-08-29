"""World Hub consumer kit — the shared package reader and its vocabulary.

Vendored from World Hub's ``kit/`` directory. Do not edit these files in
place: ``verify`` compares them against a lockfile and fails when they have
been changed by hand. Fix the kit in World Hub and re-sync.
"""

from .package_reader import (  # noqa: F401
    CONTRACT_FORMAT,
    PACKAGE_FORMAT,
    SUPPORTED_CONTRACT_FORMAT_VERSIONS,
    SUPPORTED_PROTOCOL_VERSIONS,
    PackageError,
    PackageInfo,
    extract_zip_safely,
    load_package,
    read_current_pointer,
)
