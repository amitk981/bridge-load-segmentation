import PyInstaller.__main__
import os
import sys

# Get the absolute path to the project root
project_root = os.path.abspath(os.path.dirname(__file__))

# Define the paths for data files
# We need to include templates and static files from the 'app' directory
data_files = [
    (os.path.join(project_root, 'app', 'templates'), 'app/templates'),
    (os.path.join(project_root, 'app', 'static'), 'app/static'),
]

# PyInstaller command line arguments
# --onefile: Generate a single executable
# --noconsole: Hide the terminal window (optional, but better for desktop apps)
# --add-data: Include static files and templates
# --name: Name of the output executable
# --hidden-import: Ensure dynamic imports are included
params = [
    'run_desktop.py',
    '--onefile',
    '--noconsole',
    '--name=STAAD_Offline',
    f'--add-data={os.path.join(project_root, "app", "templates")}{os.pathsep}app/templates',
    f'--add-data={os.path.join(project_root, "app", "static")}{os.pathsep}app/static',
    '--hidden-import=pydantic',
    '--hidden-import=pydantic_core',
    '--hidden-import=waitress',
    '--hidden-import=webview',
    '--clean',
]

if __name__ == '__main__':
    print("Starting PyInstaller build process...")
    PyInstaller.__main__.run(params)
    print("Build complete! Check the 'dist' folder for STAAD_Offline.exe.")
