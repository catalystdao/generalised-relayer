#!/bin/bash
git fetch

git pull --ff-only 

docker compose build