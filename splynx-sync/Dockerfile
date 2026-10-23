FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY sync.py .
# same UID as the portal container so both can share /data
RUN useradd -u 1000 -m app && mkdir -p /data && chown app:app /data
# MikroTik builds pass RUN_AS=root: RouterOS creates mounted folders as root
ARG RUN_AS=app
USER ${RUN_AS}
ENV PYTHONUNBUFFERED=1
CMD ["python", "sync.py", "run"]
