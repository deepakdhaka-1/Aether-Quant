"""Golden L1-action signatures from the official Hyperliquid Python SDK, for tests/signing_test.ts.

    engine/.venv/Scripts/python supabase/functions/tests/gen_signing.py
"""
import json
import os

from eth_account import Account
from hyperliquid.utils.signing import (order_request_to_order_wire, order_wires_to_order_action,
                                       sign_l1_action)
from hyperliquid.utils.types import Cloid

KEY = "0x" + "11" * 32          # throwaway test key, never funded
cases = []


def add(name, action, nonce, mainnet=True, vault=None):
    sig = sign_l1_action(Account.from_key(KEY), action, vault, nonce, None, mainnet)
    cases.append({"name": name, "action": action, "nonce": nonce, "mainnet": mainnet, "vault": vault,
                  "r": sig["r"], "s": sig["s"], "v": sig["v"]})


entry = order_request_to_order_wire({"coin": "xyz:NVDA", "is_buy": True, "sz": 0.37, "limit_px": 187.42,
                                     "order_type": {"limit": {"tif": "Ioc"}}, "reduce_only": False,
                                     "cloid": Cloid.from_str("0xae70c0de0123456789abcdef01234567")}, 110002)
add("ioc_entry_builder", order_wires_to_order_action([entry], {"b": "0x00000000000000000000000000000000000000aa", "f": 30}), 1760000000000)
stop = order_request_to_order_wire({"coin": "xyz:GOLD", "is_buy": False, "sz": 1.5, "limit_px": 3900.1,
                                    "order_type": {"trigger": {"triggerPx": 4100, "isMarket": True, "tpsl": "sl"}},
                                    "reduce_only": True, "cloid": None}, 110005)
add("trigger_stop", order_wires_to_order_action([stop], {"b": "0x00000000000000000000000000000000000000aa", "f": 30}), 1760000000001)
add("ioc_no_builder_testnet", order_wires_to_order_action([entry]), 1760000000002, mainnet=False)
add("cancel", {"type": "cancel", "cancels": [{"a": 110002, "o": 123456789}]}, 1760000000003)
add("update_leverage", {"type": "updateLeverage", "asset": 110002, "isCross": False, "leverage": 3}, 1760000000004)
add("big_nonce_small_px", order_wires_to_order_action([order_request_to_order_wire(
    {"coin": "BTC", "is_buy": False, "sz": 0.00012, "limit_px": 0.000123, "order_type": {"limit": {"tif": "Gtc"}},
     "reduce_only": True}, 0)]), 1999999999999)

out = {"key": KEY, "address": Account.from_key(KEY).address, "cases": cases}
with open(os.path.join(os.path.dirname(__file__), "hl_signing.json"), "w") as fh:
    json.dump(out, fh, indent=1)
print(len(cases), "cases", out["address"])
