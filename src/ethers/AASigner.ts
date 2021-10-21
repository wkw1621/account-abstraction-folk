import {BigNumber, BigNumberish, Bytes, Event, providers, Signer} from "ethers";
import {Provider, TransactionRequest} from "@ethersproject/providers";
import {Deferrable, resolveProperties} from "@ethersproject/properties";
import {EntryPoint, EntryPoint__factory, SimpleWallet, SimpleWallet__factory} from "../../typechain";
import {BytesLike, hexValue} from "@ethersproject/bytes";
import {TransactionReceipt, TransactionResponse} from "@ethersproject/abstract-provider";
import {fillAndSign} from "../userop/UserOp";
import {UserOperation} from "../userop/UserOperation";
import {clearInterval} from "timers";
import {localUserOpSender} from "./localUserOpSender";
import {rpcUserOpSender} from "./rpcUserOpSender";
import {QueueSendUserOp, sendQueuedUserOps} from "./sendQueuedUserOps";

const debug = require('debug')('aasigner')

export type SendUserOp = (userOp: UserOperation) => Promise<TransactionResponse | void>

interface AASignerOptions {
  //the entry point we're working with.
  entryPointAddress: string

  // index of this wallet within the signer. defaults to "zero".
  // use if you want multiple wallets with the same signer.
  index?: number

  //URL to send eth_sendUserOperation. if not set, use current provider
  // (note that current nodes don't support both full RPC and eth_sendUserOperation, so it is required..)
  sendUserOpRpc?: string

  //underlying RPC provider. by default, uses signer.provider
  provider?: Provider

  //if set, use this signer address to call handleOp.
  // This bypasses the RPC call and used for local testing
  debug_handleOpSigner?: Signer
}

function initSendUseOp(provider: Provider, options: AASignerOptions): SendUserOp {
  if (options.debug_handleOpSigner != null) {
    return localUserOpSender(options.entryPointAddress, options.debug_handleOpSigner)
  }
  const rpcProvider = options.sendUserOpRpc != null ?
    new providers.JsonRpcProvider(options.sendUserOpRpc) :
    (provider as providers.JsonRpcProvider)
  if (typeof rpcProvider.send != 'function') {
    throw new Error('not an rpc provider')
  }
  return rpcUserOpSender(rpcProvider)
}

/**
 * a signer that wraps account-abstraction.
 */
export class AASigner extends Signer {
  _wallet?: SimpleWallet

  private _isPhantom = true
  public entryPoint: EntryPoint

  private _chainId = 0

  readonly index: number
  readonly provider: Provider
  readonly sendUserOp: SendUserOp

  /**
   * create account abstraction signer
   * @param signer - the underlying signer. Used only for signing, not for sendTransaction (has no eth)
   * @param options.entryPoint the entryPoint contract. used for read-only operations
   * @param options.sendUserOp function to actually send the UserOp to the entryPoint.
   * @param options.index - index of this wallet for this signer.
   * @param options.provider by default, `signer.provider`. Should specify only if the signer doesn't wrap an existing provider.
   */
  constructor(readonly signer: Signer, options: AASignerOptions) {
    super();
    this.index = options.index || 0
    this.provider = options.provider || signer.provider!
    this.entryPoint = EntryPoint__factory.connect(options.entryPointAddress, signer)
    if (this.provider == null) {
      throw new Error('no provider given')
    }
    this.sendUserOp = initSendUseOp(this.provider, options)

  }

  /**
   * deposit eth into the entryPoint, to be used for gas payment for this wallet.
   * its cheaper to use deposit (by ~10000gas) rather than provide eth (and get refunded) on each request.
   * todo: add "withdraw deposit", (which must be done from the wallet itself)
   *
   * @param wealthySigner some signer with eth
   * @param amount eth value to deposit.
   */
  async addDeposit(wealthySigner: Signer, amount: BigNumberish) {
    await this.entryPoint.connect(wealthySigner).addDepositTo(await this.getAddress(), {value: amount})
  }

  /**
   * return current deposit of this wallet.
   */
  async getDeposit(): Promise<BigNumber> {
    const stakeInfo = await this.entryPoint.getStakeInfo(await this.getAddress());
    return stakeInfo.stake
  }

  //connect to a specific pre-deployed address
  // (note: in order to send transactions, the underlying signer address must be valid signer for this wallet (its owner)
  async connectWalletAddress(address: string) {
    if (this._wallet != null) {
      throw Error('already connected to wallet')
    }
    if (await this.provider!.getCode(address).then(code => code.length) <= 2) {
      throw new Error('cannot connect to non-existing contract')
    }
    this._wallet = SimpleWallet__factory.connect(address, this.signer)
    this._isPhantom = false;
  }

  connect(provider: Provider): Signer {
    throw new Error('connect not implemented')
  }

  async _deploymentTransaction(): Promise<BytesLike> {
    let ownerAddress = await this.signer.getAddress();
    return new SimpleWallet__factory()
      .getDeployTransaction(this.entryPoint.address, ownerAddress).data!
  }

  async getAddress(): Promise<string> {
    await this.syncAccount()
    return this._wallet!.address
  }

  signMessage(message: Bytes | string): Promise<string> {
    throw new Error('signMessage: unsupported by AA')
  }

  signTransaction(transaction: Deferrable<TransactionRequest>): Promise<string> {
    throw new Error('signMessage: unsupported by AA')
  }

  async getWallet(): Promise<SimpleWallet> {

    await this.syncAccount()
    return this._wallet!
  }

  //unlike real tx, we can't give hash before TX is mined: actual tx depends on
  // other UserOps packed into the same transaction.
  // to make this value meaningful, we need a provider that can do getTransactionReceipt with this virtual
  // value.
  virtualTransactionHash(userOp: UserOperation): string {
    return `userop:${userOp.sender}-${parseInt(userOp.nonce.toString())}`
  }

  //fabricate a response in a format usable by ethers users...
  async userEventResponse(userOp: UserOperation): Promise<TransactionResponse> {
    const entryPoint = this.entryPoint
    const resp: TransactionResponse = {
      hash: this.virtualTransactionHash(userOp),
      confirmations: 0,
      from: userOp.sender,
      nonce: BigNumber.from(userOp.nonce).toNumber(),
      gasLimit: BigNumber.from(userOp.callGas), //??
      value: BigNumber.from(0),
      data: hexValue(userOp.callData),
      chainId: this._chainId,
      wait: async function (confirmations?: number): Promise<TransactionReceipt> {
        return new Promise<TransactionReceipt>((resolve, reject) => {
          let listener = async function (this: any) {
            const event = arguments[arguments.length - 1] as Event
            if (event.args!.nonce != parseInt(userOp.nonce.toString())) {
              debug(`== event with wrong nonce: event.${event.args!.nonce}!= userOp.${userOp.nonce}`)
              return
            }

            const rcpt = await event.getTransactionReceipt()
            // console.log('got event with status=', event.args!.success, 'gasUsed=', rcpt.gasUsed)

            //before returning the receipt, update the status from the event.
            if (!event.args!.success) {
              debug('mark tx as failed')
              rcpt.status = 0
              const revertReasonEvents = await entryPoint.queryFilter(entryPoint.filters.UserOperationRevertReason(userOp.sender), rcpt.blockHash)
              if (revertReasonEvents[0]) {
                debug('rejecting with reason')
                reject(Error('UserOp failed with reason: ' +
                  revertReasonEvents[0].args.revertReason))
                return
              }
            }
            entryPoint.off('UserOperationEvent', listener)
            resolve(rcpt)
          }
          listener = listener.bind(listener)
          entryPoint.on('UserOperationEvent', listener)
        })
      }
    }
    return resp
  }

  async sendTransaction(transaction: Deferrable<TransactionRequest>): Promise<TransactionResponse> {

    const userOp = await this._createUserOperation(transaction)
    //get response BEFORE sending request: the response waits for events, which might be triggered before the actual send returns.
    let reponse = await this.userEventResponse(userOp);
    await this.sendUserOp(userOp)
    return reponse
  }

  async syncAccount() {
    if (!this._wallet) {
      const address = await this.entryPoint.getSenderAddress(await this._deploymentTransaction(), this.index)
      this._wallet = SimpleWallet__factory.connect(address, this.signer)
    }

    //once an account is deployed, it can no longer be a phantom.
    // but until then, we need to re-check
    if (this._isPhantom) {
      const size = await this.provider!.getCode(this._wallet.address).then(x => x.length)
      // console.log(`== __isPhantom. addr=${this._wallet.address} re-checking code size. result = `, size)
      this._isPhantom = size == 2
      // !await this.entryPoint.isContractDeployed(await this.getAddress());
    }
  }

  //return true if wallet not yet created.
  async isPhantom(): Promise<boolean> {
    await this.syncAccount()
    return this._isPhantom
  }

  async _createUserOperation(transaction: Deferrable<TransactionRequest>): Promise<UserOperation> {

    const tx: TransactionRequest = await resolveProperties(transaction)
    await this.syncAccount()

    let initCode: BytesLike | undefined
    if (this._isPhantom) {
      initCode = await this._deploymentTransaction()
    }
    const execFromEntryPoint = await this._wallet!.populateTransaction.execFromEntryPoint(tx.to!, tx.value ?? 0, tx.data!)

    let {gasPrice, maxPriorityFeePerGas, maxFeePerGas} = tx
    //gasPrice is legacy, and overrides eip1559 values:
    if (gasPrice) {
      console.log('=== using legacy "gasPrice" instead')
      maxPriorityFeePerGas = gasPrice
      maxFeePerGas = gasPrice
    }
    const userOp = await fillAndSign({
      sender: this._wallet!.address,
      initCode,
      nonce: initCode == null ? tx.nonce : this.index,
      callData: execFromEntryPoint.data!,
      callGas: tx.gasLimit,
      maxPriorityFeePerGas,
      maxFeePerGas,
    }, this.signer, this.entryPoint).catch(e => {
      console.log('ex=', e);
      throw e
    })

    return userOp
  }
}
