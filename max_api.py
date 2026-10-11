"""MAX Bot API with verified TLS; never disable certificate verification for API calls."""
import hashlib
import logging
import os
import ssl
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

import certifi
import requests
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding

BASE = 'https://platform-api2.max.ru'
# Official Russian Trusted Root CA, SHA-256 of DER certificate (not PEM bytes).
ROOT_FINGERPRINT = 'd26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31'
ROOT_URL = 'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt'
CA_PATH = Path(os.getenv('CA_BUNDLE','/tmp/radar_max_ca.pem'))
log = logging.getLogger('radar.max')


def make_ca_bundle():
    """Pin root downloaded from official CDN; unverified TLS ONLY while fetching
    the pinned certificate. Never for bot messages/tokens or webhook calls.
    """
    if CA_PATH.is_file():
        return str(CA_PATH)
    try:
        with urllib.request.urlopen(ROOT_URL, timeout=12) as r:
            raw = r.read(20000)
    except (ssl.SSLError, OSError) as exc:
        # Some hosts do not initially trust the Ministry root. Fingerprint protects
        # the bootstrap payload even on an untrusted TLS connection.
        log.warning('Нужно добавить корневой сертификат Минцифры (pin SHA-256): %s',type(exc).__name__)
        context = ssl._create_unverified_context()
        with urllib.request.urlopen(ROOT_URL, context=context, timeout=12) as r:
            raw = r.read(20000)
    cert = x509.load_pem_x509_certificate(raw)
    digest = hashlib.sha256(cert.public_bytes(Encoding.DER)).hexdigest()
    if digest != ROOT_FINGERPRINT:
        raise RuntimeError('Контрольная сумма корневого сертификата Минцифры не совпала')
    if not cert.subject == cert.issuer:
        raise RuntimeError('Сертификат не является корневым')
    CA_PATH.parent.mkdir(parents=True, exist_ok=True)
    CA_PATH.write_bytes(Path(certifi.where()).read_bytes() + b'\n' + cert.public_bytes(Encoding.PEM))
    return str(CA_PATH)


class MaxFailure(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class MaxClient:
    def __init__(self, token, session=None):
        if not token or not token.strip():
            raise RuntimeError('Отсутствует MAX_BOT_TOKEN')
        self.session = session or requests.Session()
        self.session.headers.update({'Authorization':token.strip(),'Content-Type':'application/json'})
        self.session.verify = make_ca_bundle()

    def request(self, method, path, params=None, payload=None):
        try:
            r = self.session.request(method, BASE+path, params=params, json=payload, timeout=(6,18))
        except requests.RequestException as exc:
            raise MaxFailure(0, type(exc).__name__) from exc
        try:
            data=r.json()
        except ValueError:
            data={}
        if r.status_code>=400:
            raise MaxFailure(r.status_code, f'MAX API HTTP {r.status_code}')
        if isinstance(data,dict) and data.get('success') is False:
            raise MaxFailure(r.status_code, 'MAX API success=false')
        if not isinstance(data,dict):
            raise MaxFailure(r.status_code,'Неожиданный формат MAX API')
        return data

    def send(self, uid, body):
        result=self.request('POST','/messages',{'user_id':str(uid)},body)
        if not result.get('message'):
            raise MaxFailure(200,'MAX API не вернул созданное сообщение')
        return result

    def answer(self, callback_id, message):
        result=self.request('POST','/answers',{'callback_id':callback_id},{'message':message})
        if result.get('success') is not True:
            raise MaxFailure(200,'MAX API не подтвердил callback')
        return result

    def me(self):
        result=self.request('GET','/me')
        if not result.get('user_id'):
            raise MaxFailure(200,'MAX не вернул ID бота')
        return result
