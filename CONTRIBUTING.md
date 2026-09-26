# Contributing to OpenExtract

Thank you for your interest in contributing! This document provides guidelines
for contributing to OpenExtract.

## Getting Started

1. Fork the repository
2. Clone your fork **and** [ios-backup-core](https://github.com/charleswest775/ios-backup-core) side by side
   (`python/requirements.txt` installs it from `../ios-backup-core`):
   ```bash
   git clone https://github.com/charleswest775/ios-backup-core.git
   git clone https://github.com/YOUR_USERNAME/openextract.git
   ```
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Set up your dev environment (see README.md)
5. Make your changes
6. Test thoroughly
7. Commit with a descriptive message (see Commit Convention below)
8. Push and open a Pull Request

## Development Setup

```bash
npm install
python -m venv .venv && source .venv/bin/activate   # macOS/Linux
# Windows: python -m venv .venv && .venv\Scripts\activate
cd python && pip install -r requirements.txt && cd ..
npm run dev
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation changes
- `style:` — Formatting, no code change
- `refactor:` — Code restructuring, no feature change
- `test:` — Adding or updating tests
- `chore:` — Build, CI, dependency updates

Examples:
- `feat: add voicemail playback component`
- `fix: handle nanosecond timestamps in iOS 17 backups`
- `docs: add Windows setup instructions`
- `refactor: extract date utilities into shared module`

## Branch Naming

- `feature/description` — New features
- `fix/description` — Bug fixes
- `docs/description` — Documentation
- `refactor/description` — Code improvements

## Pull Requests

- Keep PRs focused on a single concern
- Include a clear description of what and why
- Reference any related issues
- Ensure the app builds and runs before submitting

## Code Style

- **TypeScript/React**: Follow existing patterns, use functional components with hooks
- **Python**: Follow PEP 8, use type hints, docstrings on public functions
- **General**: Descriptive variable names, comments for "why" not "what"

## Reporting Issues

Use GitHub Issues with these labels:
- `bug` — Something isn't working
- `enhancement` — Feature request
- `good first issue` — Good for newcomers
- `help wanted` — Extra attention needed

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
