# ur_money_notifier

## Install global dependencies (skip if already installed)
`npm install -g typings`
`npm install -g node-inspector`

## Install local dependencies
```script
git clone git@github.com:urcapital/ur_money_notifier.git
cd ur_money_notifer
npm install
typings install
```
## Initial configuration
* Create ssh tunnel to rpcnode: `ssh -f  -o StrictHostKeyChecking=no -N -L 9595:127.0.0.1:9595 root@45.55.7.79`
* Create local copy of environment files: `heroku config --app ur-money-notifier-staging -s > .env`
* Edit .env and change value of NODE_ENV to dev and FIREBASE_PROJECT_ID to your desired Firebase project

## Run Locally
* Run this: `heroku local`

## Debug Locally
* Run this: `npm run-script start-node-debug`

## deploy to staging or production
* Just merge your branch to dev or master, respectively
