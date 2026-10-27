FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git curl bash tmux procps ca-certificates util-linux && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pytest==8.4.2
WORKDIR /app
RUN git init -b main && git config user.email eval@example.invalid && git config user.name Evaluation && git commit --allow-empty -m baseline && git tag baseline
