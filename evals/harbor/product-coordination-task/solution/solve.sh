#!/bin/bash
set -eu
cp -r /solution/reference/config_service /app/
printf '#!/usr/bin/env python3\n' > /app/config_server
cat /solution/reference/config_server.py >> /app/config_server
chmod +x /app/config_server
cd /app
git add config_server config_service
git commit -m 'Reference implementation'
