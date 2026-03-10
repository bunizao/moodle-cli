"""Custom exceptions for moodle-cli."""


class MoodleCLIError(Exception):
    """Base exception for moodle-cli."""


class AuthError(MoodleCLIError):
    """Authentication failed — no valid session found."""


class MoodleAPIError(MoodleCLIError):
    """Moodle API returned an error response."""

    def __init__(self, message: str, error_code: str | None = None):
        super().__init__(message)
        self.error_code = error_code
