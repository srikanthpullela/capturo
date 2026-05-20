#!/usr/bin/env python3
"""Generate Capturo tray icons using the same mark as the app icon."""
import subprocess

subprocess.run(['/Users/srikanthpullela/Desktop/snapcraft/gen-app-icon.py'], check=True)
print('tray-icon.png and tray-icon-light.png refreshed from shared Capturo mark')
