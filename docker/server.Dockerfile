FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server ./server
EXPOSE 8011
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8011"]
