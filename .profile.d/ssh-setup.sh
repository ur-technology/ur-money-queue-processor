# file: .profile.d/ssh-setup.sh

#!/bin/bash
echo $0: creating public and private key files

# Create the .ssh directory
echo $0: creating ssh directory
mkdir -p ${HOME}/.ssh
chmod 700 ${HOME}/.ssh

# Create the public and private key files from the environment variables.
echo $0: setting up public key
echo "${HEROKU_PUBLIC_KEY}" > ${HOME}/.ssh/id_rsa_heroku.pub
chmod 644 ${HOME}/.ssh/id_rsa_heroku.pub

# Note use of double quotes, required to preserve newlines
echo $0: setting up private key
echo "${HEROKU_PRIVATE_KEY}" > ${HOME}/.ssh/id_rsa_heroku
chmod 600 ${HOME}/.ssh/id_rsa_heroku

# Preload the known_hosts file  (see "version 2" below)

# Start the SSH tunnel if not already running
echo $0: running ssh
SSH_CMD="ssh -f -i ${HOME}/.ssh/id_rsa_heroku -o StrictHostKeyChecking=no -N -L 9595:127.0.0.1:9595 root@${RPCNODE1}"

echo $0: confirming setup
PID=`pgrep -f "${SSH_CMD}"`
if [ $PID ] ; then
    echo $0: tunnel already running on ${PID}
else
    echo $0 launching tunnel
    $SSH_CMD
fi
