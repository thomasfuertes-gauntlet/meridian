/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/meridian.json`.
 */
export type Meridian = {
  "address": "GMwKXYNKRkN3wGdgAwR4BzG2RfPGGLGjehuoNwUzBGk2",
  "metadata": {
    "name": "meridian",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Binary outcome markets for MAG7 stocks on Solana"
  },
  "instructions": [
    {
      "name": "addStrike",
      "discriminator": [
        226,
        190,
        94,
        4,
        5,
        106,
        15,
        120
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "ticker"
              },
              {
                "kind": "arg",
                "path": "strikePrice"
              },
              {
                "kind": "arg",
                "path": "date"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "ticker",
          "type": "string"
        },
        {
          "name": "strikePrice",
          "type": "u64"
        },
        {
          "name": "date",
          "type": "i64"
        },
        {
          "name": "closeTime",
          "type": "i64"
        }
      ]
    },
    {
      "name": "adminSettle",
      "discriminator": [
        138,
        218,
        221,
        118,
        96,
        220,
        75,
        11
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "buyYes",
      "discriminator": [
        124,
        76,
        113,
        130,
        177,
        112,
        187,
        104
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "userYes",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "maxPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "cancelOrder",
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "refundDestination",
          "docs": [
            "Refund destination - must be owned by the order owner"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "claimFills",
      "discriminator": [
        167,
        244,
        211,
        249,
        74,
        110,
        41,
        32
      ],
      "accounts": [
        {
          "name": "payer",
          "docs": [
            "Payer/signer. Permissionless - anyone can crank claims for any owner."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "owner"
        },
        {
          "name": "ownerUsdc",
          "writable": true
        },
        {
          "name": "ownerYes",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "closeMarket",
      "discriminator": [
        88,
        154,
        248,
        186,
        48,
        14,
        123,
        244
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "docs": [
            "OrderBook to close. AccountLoader validates zero_copy discriminator.",
            "Key match to market.order_book validated in handler body."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createStrikeMarket",
      "discriminator": [
        21,
        162,
        50,
        119,
        68,
        218,
        221,
        35
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "ticker"
              },
              {
                "kind": "arg",
                "path": "strikePrice"
              },
              {
                "kind": "arg",
                "path": "date"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "ticker",
          "type": "string"
        },
        {
          "name": "strikePrice",
          "type": "u64"
        },
        {
          "name": "date",
          "type": "i64"
        },
        {
          "name": "closeTime",
          "type": "i64"
        }
      ]
    },
    {
      "name": "freezeMarket",
      "discriminator": [
        184,
        154,
        237,
        98,
        127,
        82,
        217,
        180
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "mintPair",
      "discriminator": [
        19,
        149,
        94,
        110,
        181,
        186,
        33,
        107
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "userYes",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "userNo",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "pause",
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "placeOrder",
      "discriminator": [
        51,
        194,
        155,
        175,
        109,
        130,
        96,
        106
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "userYes",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": {
            "defined": {
              "name": "orderSide"
            }
          }
        },
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "redeem",
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenMint",
          "writable": true
        },
        {
          "name": "userToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sellYes",
      "discriminator": [
        128,
        214,
        65,
        190,
        69,
        69,
        53,
        8
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "userUsdc",
          "writable": true
        },
        {
          "name": "userYes",
          "writable": true
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "minPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "settleMarket",
      "discriminator": [
        193,
        153,
        95,
        216,
        166,
        6,
        144,
        217
      ],
      "accounts": [
        {
          "name": "settler",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "priceUpdate"
        }
      ],
      "args": []
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "unwindOrder",
      "discriminator": [
        232,
        5,
        200,
        121,
        42,
        160,
        170,
        36
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.ticker",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.strike_price",
                "account": "strikeMarket"
              },
              {
                "kind": "account",
                "path": "market.date",
                "account": "strikeMarket"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obUsdcVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  117,
                  115,
                  100,
                  99,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "obYesVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  98,
                  95,
                  121,
                  101,
                  115,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "refundUsdcDestination",
          "docs": [
            "Refund destination for bid-side escrow."
          ],
          "writable": true
        },
        {
          "name": "refundYesDestination",
          "docs": [
            "Refund destination for ask-side escrow."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "adminSettleDelaySecs",
          "type": "i64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "globalConfig",
      "discriminator": [
        149,
        8,
        156,
        202,
        160,
        252,
        176,
        217
      ]
    },
    {
      "name": "orderBook",
      "discriminator": [
        55,
        230,
        125,
        218,
        149,
        39,
        65,
        248
      ]
    },
    {
      "name": "priceUpdateV2",
      "discriminator": [
        34,
        241,
        35,
        99,
        157,
        126,
        244,
        205
      ]
    },
    {
      "name": "strikeMarket",
      "discriminator": [
        109,
        109,
        58,
        228,
        193,
        219,
        99,
        7
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Unauthorized: not admin"
    },
    {
      "code": 6001,
      "name": "marketAlreadySettled",
      "msg": "Market already settled"
    },
    {
      "code": 6002,
      "name": "marketNotSettled",
      "msg": "Market not settled"
    },
    {
      "code": 6003,
      "name": "paused",
      "msg": "Protocol is paused"
    },
    {
      "code": 6004,
      "name": "invalidTicker",
      "msg": "Invalid ticker"
    },
    {
      "code": 6005,
      "name": "unsupportedTicker",
      "msg": "Unsupported ticker for this deployment"
    },
    {
      "code": 6006,
      "name": "invalidAmount",
      "msg": "Invalid amount: must be greater than zero"
    },
    {
      "code": 6007,
      "name": "invalidCloseTime",
      "msg": "Invalid close time for market"
    },
    {
      "code": 6008,
      "name": "vaultInvariantViolation",
      "msg": "Vault invariant violation: balance mismatch"
    },
    {
      "code": 6009,
      "name": "invalidTokenMint",
      "msg": "Invalid token mint: not a market mint"
    },
    {
      "code": 6010,
      "name": "invalidOutcome",
      "msg": "Invalid outcome: cannot settle as Pending"
    },
    {
      "code": 6011,
      "name": "invalidMarketState",
      "msg": "Invalid market state for this instruction"
    },
    {
      "code": 6012,
      "name": "marketFrozen",
      "msg": "Market trading is frozen"
    },
    {
      "code": 6013,
      "name": "marketNotFrozen",
      "msg": "Market is not frozen"
    },
    {
      "code": 6014,
      "name": "settlementTooEarly",
      "msg": "Settlement too early: market not closed yet"
    },
    {
      "code": 6015,
      "name": "adminSettleTooEarly",
      "msg": "Admin settle too early: must wait 1 hour after close"
    },
    {
      "code": 6016,
      "name": "priceStale",
      "msg": "Oracle price is stale"
    },
    {
      "code": 6017,
      "name": "priceConfidenceTooWide",
      "msg": "Oracle confidence band too wide"
    },
    {
      "code": 6018,
      "name": "orderBookFull",
      "msg": "Order book is full"
    },
    {
      "code": 6019,
      "name": "crossingOrdersUseDedicatedPath",
      "msg": "Crossing orders must use a dedicated trade-path instruction"
    },
    {
      "code": 6020,
      "name": "invalidPrice",
      "msg": "Invalid price: must be between 1 and 999999 (exclusive of 0 and 1_000_000)"
    },
    {
      "code": 6021,
      "name": "noMatchingOrders",
      "msg": "No matching orders found"
    },
    {
      "code": 6022,
      "name": "atomicTradeIncomplete",
      "msg": "Atomic trade could not be fully filled"
    },
    {
      "code": 6023,
      "name": "orderNotFound",
      "msg": "Order not found"
    },
    {
      "code": 6024,
      "name": "notOrderOwner",
      "msg": "Not the order owner"
    },
    {
      "code": 6025,
      "name": "orderBookEscrowNotEmpty",
      "msg": "Order book escrow is not empty"
    },
    {
      "code": 6026,
      "name": "missingOrderBookAccounts",
      "msg": "Missing order book validation accounts"
    },
    {
      "code": 6027,
      "name": "invalidOrderBookAccount",
      "msg": "Invalid order book validation accounts"
    },
    {
      "code": 6028,
      "name": "missingCounterpartyAccount",
      "msg": "Missing counterparty account for fill"
    },
    {
      "code": 6029,
      "name": "invalidCounterpartyAccount",
      "msg": "Invalid counterparty token account"
    },
    {
      "code": 6030,
      "name": "invalidCollateralMint",
      "msg": "Invalid collateral mint for market"
    },
    {
      "code": 6031,
      "name": "invalidOraclePrice",
      "msg": "Oracle price is invalid"
    },
    {
      "code": 6032,
      "name": "invalidSettlementWindow",
      "msg": "Oracle update is outside the settlement window"
    },
    {
      "code": 6033,
      "name": "invalidSettlementPrice",
      "msg": "Settlement price is invalid"
    },
    {
      "code": 6034,
      "name": "creditLedgerFull",
      "msg": "Credit ledger is full"
    },
    {
      "code": 6035,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    }
  ],
  "types": [
    {
      "name": "creditEntry",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "usdcClaimable",
            "type": "u64"
          },
          {
            "name": "yesClaimable",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "globalConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "adminSettleDelaySecs",
            "type": "i64"
          },
          {
            "name": "oraclePolicies",
            "type": {
              "vec": {
                "defined": {
                  "name": "oraclePolicy"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketOutcome",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pending"
          },
          {
            "name": "yesWins"
          },
          {
            "name": "noWins"
          }
        ]
      }
    },
    {
      "name": "marketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "created"
          },
          {
            "name": "frozen"
          },
          {
            "name": "settled"
          }
        ]
      }
    },
    {
      "name": "oraclePolicy",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticker",
            "type": "string"
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "confidenceFilterBps",
            "type": "u16"
          },
          {
            "name": "maxPriceStalenessSecs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "order",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "isActive",
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "orderBook",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "obUsdcVault",
            "type": "pubkey"
          },
          {
            "name": "obYesVault",
            "type": "pubkey"
          },
          {
            "name": "nextOrderId",
            "type": "u64"
          },
          {
            "name": "bidCount",
            "type": "u16"
          },
          {
            "name": "askCount",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "creditCount",
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "bids",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "order"
                  }
                },
                32
              ]
            }
          },
          {
            "name": "asks",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "order"
                  }
                },
                32
              ]
            }
          },
          {
            "name": "credits",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "creditEntry"
                  }
                },
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "orderSide",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "bid"
          },
          {
            "name": "ask"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "settlementSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "oracle"
          },
          {
            "name": "admin"
          }
        ]
      }
    },
    {
      "name": "strikeMarket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticker",
            "type": "string"
          },
          {
            "name": "strikePrice",
            "type": "u64"
          },
          {
            "name": "date",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "marketStatus"
              }
            }
          },
          {
            "name": "outcome",
            "type": {
              "defined": {
                "name": "marketOutcome"
              }
            }
          },
          {
            "name": "totalPairsMinted",
            "type": "u64"
          },
          {
            "name": "yesMint",
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "orderBook",
            "type": "pubkey"
          },
          {
            "name": "obUsdcVault",
            "type": "pubkey"
          },
          {
            "name": "obYesVault",
            "type": "pubkey"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "frozenAt",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "settledAt",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "settlementPrice",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "settlementSource",
            "type": {
              "option": {
                "defined": {
                  "name": "settlementSource"
                }
              }
            }
          },
          {
            "name": "closeTime",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    }
  ]
};
