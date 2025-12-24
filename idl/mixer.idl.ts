/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/mixer.json`.
 */
export type Mixer = {
  "address": "BhdU135mdBb1V7jcKdAZoFueNMLMeAtAbBgUZehqRte7",
  "metadata": {
    "name": "mixer",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "close_multi_layer_staging",
      "discriminator": [
        129,
        160,
        206,
        72,
        166,
        109,
        70,
        78
      ],
      "accounts": [
        {
          "name": "closer",
          "writable": true,
          "signer": true
        },
        {
          "name": "staging",
          "writable": true
        },
        {
          "name": "original_payer"
        },
        {
          "name": "recipient"
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "_layer",
          "type": "u8"
        },
        {
          "name": "_round_id",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [],
      "args": []
    },
    {
      "name": "multi_layer_transfer",
      "discriminator": [
        33,
        180,
        115,
        143,
        95,
        176,
        164,
        18
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "staging1",
          "writable": true
        },
        {
          "name": "staging2",
          "writable": true
        },
        {
          "name": "staging3",
          "writable": true
        },
        {
          "name": "staging4",
          "writable": true
        },
        {
          "name": "recipient",
          "writable": true
        },
        {
          "name": "system_program",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "transfer_lamports",
          "type": "u64"
        },
        {
          "name": "layers",
          "type": "u8"
        },
        {
          "name": "round_id",
          "type": "u64"
        },
        {
          "name": "layers_data",
          "type": {
            "option": "bytes"
          }
        }
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "ZeroTransferAmount",
      "msg": "Transfer amount must be greater than zero"
    },
    {
      "code": 6001,
      "name": "RecipientMustBeSystemProgramOwned",
      "msg": "Recipient account must be owned by the System Program"
    },
    {
      "code": 6002,
      "name": "StagingAccountInUse",
      "msg": "Provided staging account is already in use"
    },
    {
      "code": 6003,
      "name": "InvalidStagingAccount",
      "msg": "Invalid staging account"
    },
    {
      "code": 6004,
      "name": "StagingMustSign",
      "msg": "Staging account must sign the transaction"
    },
    {
      "code": 6005,
      "name": "InsufficientStagingBalance",
      "msg": "Insufficient balance in staging account"
    },
    {
      "code": 6006,
      "name": "ArithmeticOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6007,
      "name": "ArithmeticUnderflow",
      "msg": "Arithmetic underflow"
    },
    {
      "code": 6008,
      "name": "InvalidLayerCount",
      "msg": "Invalid layer count, must be between 2 and 5"
    },
    {
      "code": 6009,
      "name": "InvalidEncryptedDataLength",
      "msg": "Invalid encrypted data length. Expected 96 bytes."
    }
  ]
}