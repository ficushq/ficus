#!/bin/bash
set -eu
cp -r /solution/reference/code_searcher /app/
printf '#!/usr/bin/env python3\n' > /app/code_search
cat /solution/reference/code_search.py >> /app/code_search
chmod +x /app/code_search
cd /app
git add code_search code_searcher
git commit -m 'Reference implementation'
