docker-compose up -d redis server && docker stats stress-test-app-server-1

 docker-compose --profile test up slow-client data-flood

 docker inspect stress-test-app-server-1 --format='OOMKilled: {{.State.OOMKilled}}'