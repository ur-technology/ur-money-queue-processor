# ur_money_notifier

## Install global dependencies (skip if already installed)
`npm install -g typings`

## Install local dependencies
```script
git clone git@github.com:urcapital/ur_money_notifier.git
cd ur_money_notifer
npm install
typings install
```
## To run locally:
* 1: create local copy of environment files: `heroku config --app ur-money-notifier-staging -s > .env`
* 2: edit file and change value of NODE_ENV to dev and FIREBASE_PROJECT_ID to your desired Firebase project
* 3: Run this: `heroku local`

## deploy to staging or production
* Just merge your branch to dev or master, respectively
