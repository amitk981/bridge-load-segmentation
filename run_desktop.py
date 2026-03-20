import webview
import threading
import socket
from app.main import app
from waitress import serve
import sys
import os

# Handle resource paths for PyInstaller bundle context
if getattr(sys, 'frozen', False):
    project_root = sys._MEIPASS
else:
    project_root = os.path.abspath(os.path.dirname(__file__))

# Ensure the root directory is in sys.path to allow 'from app.main import app'
if project_root not in sys.path:
    sys.path.insert(0, project_root)

def find_free_port():
    """Find a random free port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]

def start_server(port):
    """Start the Flask server using Waitress."""
    # Fixed: Use waitress for Windows compatibility and stability
    serve(app, host='127.0.0.1', port=port)

if __name__ == '__main__':
    # Determine the port
    port = find_free_port()
    url = f'http://127.0.0.1:{port}'

    # Start Flask in a background thread
    server_thread = threading.Thread(target=start_server, args=(port,), daemon=True)
    server_thread.start()

    # Create the webview window
    # We set a nice size and title for the engineering application
    webview.create_window(
        'STAAD - Bridge Load Segmentation & Box Culvert Design',
        url,
        width=1280,
        height=800,
        min_size=(1024, 768)
    )

    # Start the webview loop
    # On Windows, this will use the installed Edge WebView2 runtime
    webview.start()
