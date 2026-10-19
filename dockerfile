FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py ./main.py
COPY backend/ ./backend/
COPY static/ ./static/
# No secrets are needed: the server only serves the app and public market data.
RUN useradd -m app && chown -R app /app
USER app
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD python -c "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:%s/api/health' % os.environ.get('PORT','3000')).status==200 else 1)"
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-3000} --proxy-headers --forwarded-allow-ips='*'"]
