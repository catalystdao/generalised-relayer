set -euxo pipefail

if [ "$(docker ps -a -q )" ]; then
    docker rm -f $(docker ps -a -q)
    docker volume rm $(docker volume ls -q)
fi