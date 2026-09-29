# Test targets for rules/python.yml, annotated with the rule IDs each line
# must or must not match.
import hashlib
import os
import pickle
import subprocess

import requests
import yaml


def eval_cases(expr):
    # ruleid: py-eval-dynamic
    eval(expr)
    # ok: py-eval-dynamic
    eval("1 + 1")
    # ruleid: py-eval-dynamic
    exec(expr)


def shell_cases(name):
    # ruleid: py-subprocess-shell-dynamic
    subprocess.run("ls " + name, shell=True)
    # ok: py-subprocess-shell-dynamic
    subprocess.run("ls -l", shell=True)
    # ok: py-subprocess-shell-dynamic
    subprocess.run(["ls", name])
    # ruleid: py-subprocess-shell-dynamic
    os.system(f"rm {name}")
    # ok: py-subprocess-shell-dynamic
    os.system("true")


def yaml_cases(text):
    # ruleid: py-yaml-unsafe-load
    yaml.load(text)
    # ruleid: py-yaml-unsafe-load
    yaml.load(text, Loader=yaml.Loader)
    # ok: py-yaml-unsafe-load
    yaml.load(text, Loader=yaml.SafeLoader)
    # ok: py-yaml-unsafe-load
    yaml.safe_load(text)


def pickle_cases(blob):
    # ruleid: py-pickle-load
    return pickle.loads(blob)


def tls_cases(url):
    # ruleid: py-tls-verification-disabled
    requests.get(url, verify=False)
    # ok: py-tls-verification-disabled
    requests.get(url, verify="/etc/ssl/certs/ca.pem")


def sql_cases(cur, user_id):
    # ruleid: py-sql-string-building
    cur.execute(f"SELECT * FROM users WHERE id = {user_id}")
    # ruleid: py-sql-string-building
    cur.execute("SELECT * FROM users WHERE id = %s" % user_id)
    # ok: py-sql-string-building
    cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))


def flask_cases(app):
    # ruleid: py-flask-debug
    app.run(debug=True)
    # ok: py-flask-debug
    app.run(host="127.0.0.1")


def hash_cases(data):
    # ruleid: py-weak-hash
    hashlib.md5(data)
    # ok: py-weak-hash
    hashlib.sha256(data)
