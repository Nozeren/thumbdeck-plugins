# Python

Toolkit buttons for Python projects: the virtual environment, dependencies and tests; commands use the project's `.venv` when it has one.

- **create venv**: `python3 -m venv .venv`. Create a virtual environment in .venv (only when it applies)
- **install**: `{python} -m pip install -r requirements.txt`. Install requirements.txt into the project's Python (only when it applies)
- **install (editable)**: `{python} -m pip install -e .`. Install the project itself, in editable mode (only when it applies)
- **pytest**: `{python} -m pytest`. Run the tests (only when it applies)
