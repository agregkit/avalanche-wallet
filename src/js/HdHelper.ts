import {KeyChain as AVMKeyChain, KeyPair as AVMKeyPair, UTXOSet as AVMUTXOSet} from "avalanche/dist/apis/avm";
import {UTXOSet as PlatformUTXOSet} from "avalanche/dist/apis/platformvm";
import {getPreferredHRP} from "avalanche/dist/utils";
import {ava, avm, bintools, pChain} from "@/AVA";
import HDKey from 'hdkey';
import {Buffer} from "buffer/";
import {KeyChain as PlatformVMKeyChain, KeyPair as PlatformVMKeyPair} from "avalanche/dist/apis/platformvm";
import {SECP256k1KeyPair} from "avalanche/dist/common";
import {getAddressDetailX} from "@/explorer_api";


const INDEX_RANGE: number = 20; // a gap of at least 20 indexes is needed to claim an index unused

const SCAN_SIZE: number = 100; // the total number of utxos to look at initially to calculate last index
const SCAN_RANGE: number = SCAN_SIZE - INDEX_RANGE; // How many items are actually scanned

type HelperChainId =  'X' | 'P';
class HdHelper {
    chainId: HelperChainId;
    keyChain: AVMKeyChain|PlatformVMKeyChain;
    keyCache: {
        [index: number]: AVMKeyPair|PlatformVMKeyPair
    }
    addressCache: {
        [index: number]: string;
    }
    hdCache: {
        [index: number]: HDKey;
    }
    changePath: string
    masterKey: HDKey;
    hdIndex: number;
    utxoSet: AVMUTXOSet | PlatformUTXOSet;
    isPublic: boolean;

    constructor(changePath: string, masterKey: HDKey, chainId: HelperChainId = 'X', isPublic: boolean = false) {
        this.changePath = changePath;
        this.chainId = chainId;
        let hrp = getPreferredHRP(ava.getNetworkID());
        if(chainId==='X'){
            this.keyChain = new AVMKeyChain(hrp, chainId);
            this.utxoSet = new AVMUTXOSet();
        }else{
            this.keyChain = new PlatformVMKeyChain(hrp, chainId);
            this.utxoSet = new PlatformUTXOSet();
        }
        this.keyCache = {};
        this.addressCache = {};
        this.hdCache = {};
        this.masterKey = masterKey;
        this.hdIndex = 0;
        this.isPublic = isPublic;
        this.oninit();
    }

    async oninit(){
        this.hdIndex = await this.findAvailableIndex();
        if(!this.isPublic){
            this.updateKeychain();
        }
        this.updateUtxos();
    }

    // When the wallet connects to a different network
    // Clear internal data and scan again
    async onNetworkChange(){
        this.clearCache();
        let hrp = getPreferredHRP(ava.getNetworkID());
        if(this.chainId === 'X'){
            this.keyChain = new AVMKeyChain(hrp, this.chainId);
            this.utxoSet = new AVMUTXOSet();
        }else{
            this.keyChain = new PlatformVMKeyChain(hrp, this.chainId);
            this.utxoSet = new PlatformUTXOSet();
        }
        this.hdIndex = 0;
        await this.oninit();
    }

    // Increments the hd index by one and adds the key
    // returns the new keypair
    incrementIndex(): number{
        let newIndex: number = this.hdIndex+1;

        if(!this.isPublic){
            if(this.chainId==='X'){
                let keychain = this.keyChain as AVMKeyChain;
                let newKey = this.getKeyForIndex(newIndex) as AVMKeyPair;
                keychain.addKey(newKey);
            }else{
                let keychain = this.keyChain as PlatformVMKeyChain;
                let newKey = this.getKeyForIndex(newIndex) as PlatformVMKeyPair;
                keychain.addKey(newKey);
            }
        }


        this.hdIndex = newIndex;
        return newIndex;
    }

    async updateHdIndex(){
        this.hdIndex = await this.findAvailableIndex();
        this.updateKeychain();
    }



    async platformGetAllUTXOsForAddresses(addrs: string[], endIndex:any = undefined): Promise<PlatformUTXOSet>{
        let response;
        if(!endIndex){
            response = await pChain.getUTXOs(addrs);
        }else{
            response = await pChain.getUTXOs(addrs, undefined, 0, endIndex);
        }


        let utxoSet = response.utxos;
        let utxos = utxoSet.getAllUTXOs();
        let nextEndIndex = response.endIndex;
        let len = response.numFetched;

        if(len >= 1024){
            let subUtxos = await this.platformGetAllUTXOsForAddresses(addrs, nextEndIndex)
            return utxoSet.merge(subUtxos)
        }

        return utxoSet;
    }

    async avmGetAllUTXOsForAddresses(addrs: string[], endIndex:any = undefined): Promise<AVMUTXOSet>{
        let response;
        if(!endIndex){
            response = await avm.getUTXOs(addrs);
        }else{
            response = await avm.getUTXOs(addrs, undefined, 0, endIndex);
        }

        let utxoSet = response.utxos;
        let utxos = utxoSet.getAllUTXOs();
        let nextEndIndex = response.endIndex;
        let len = response.numFetched;

        if(len >= 1024){
            let subUtxos = await this.avmGetAllUTXOsForAddresses(addrs, nextEndIndex)
            return utxoSet.merge(subUtxos)
        }
        return utxoSet;
    }

    // helper method to get utxos for more than 1024 addresses
    async avmGetAllUTXOs(addrs: string[]): Promise<AVMUTXOSet>{
        if(addrs.length<=1024){
            let utxos = await this.avmGetAllUTXOsForAddresses(addrs);
            return utxos;
        }else{
            //Break the list in to 1024 chunks
            let chunk = addrs.slice(0,1024);
            let remainingChunk = addrs.slice(1024);

            let newSet = await this.avmGetAllUTXOsForAddresses(chunk);
            return newSet.merge(await this.avmGetAllUTXOs(remainingChunk))
        }
    }

    // helper method to get utxos for more than 1024 addresses
    async platformGetAllUTXOs(addrs: string[]): Promise<PlatformUTXOSet>{
        if(addrs.length<=1024){
            let newSet = await this.platformGetAllUTXOsForAddresses(addrs);
            return newSet;
        }else{
            //Break the list in to 1024 chunks
            let chunk = addrs.slice(0,1024);
            let remainingChunk = addrs.slice(1024);

            let newSet = await this.platformGetAllUTXOsForAddresses(chunk);

            return newSet.merge(await this.platformGetAllUTXOs(remainingChunk))
        }
    }


    // Fetches the utxos for the current keychain
    // and increments the index if last index has a utxo
    async updateUtxos(): Promise<AVMUTXOSet|PlatformUTXOSet>{
        // TODO: Optimize this
        await this.updateHdIndex()

        // let addrs: string[] = this.keyChain.getAddressStrings();
        let addrs: string[] = this.getAllDerivedAddresses();
        let result: AVMUTXOSet|PlatformUTXOSet;

        if(this.chainId==='X'){
            result = await this.avmGetAllUTXOs(addrs);
        }else{
            result = await this.platformGetAllUTXOs(addrs);
            // console.log(result);
        }
        this.utxoSet = result; // we can use local copy of utxos as cache for some functions


        // If the hd index is full, increment
        let currentAddr = this.getCurrentAddress();
        let currentAddrBuf = bintools.parseAddress(currentAddr,this.chainId);
        let curentUtxos = result.getUTXOIDs([currentAddrBuf])

        if(curentUtxos.length>0){
            this.incrementIndex();
        }
        return result;
    }

    // Returns more addresses than the current index
    getExtendedAddresses(){
        let hdIndex = this.hdIndex;
        return this.getAllDerivedAddresses(hdIndex+INDEX_RANGE);
    }
    async getAtomicUTXOs(){
        let hdIndex = this.hdIndex;
        let addrs: string[] = this.getAllDerivedAddresses();
        if(this.chainId === 'P'){
            let result: PlatformUTXOSet = (await pChain.getUTXOs(addrs, avm.getBlockchainID())).utxos;
            return result;
        }else{
            let result: AVMUTXOSet = (await avm.getUTXOs(addrs, pChain.getBlockchainID())).utxos;
            return result;
        }
    }

    getUtxos(): AVMUTXOSet|PlatformUTXOSet{
        return this.utxoSet;
    }


    // Updates the helper keychain to contain keys upto the HD Index
    updateKeychain(): AVMKeyChain|PlatformVMKeyChain{
        let hrp = getPreferredHRP(ava.getNetworkID())
        let keychain: AVMKeyChain | PlatformVMKeyChain;

        if(this.chainId==='X'){
            keychain = new AVMKeyChain(hrp, this.chainId);
        }else{
            keychain = new PlatformVMKeyChain(hrp, this.chainId);
        }

        for(let i:number=0; i<=this.hdIndex; i++){
            let key : AVMKeyPair | PlatformVMKeyPair;
            if(this.chainId==='X') {
                key = this.getKeyForIndex(i) as AVMKeyPair;
                (keychain as AVMKeyChain).addKey(key);
            }else{
                key = this.getKeyForIndex(i) as PlatformVMKeyPair;
                (keychain as PlatformVMKeyChain).addKey(key);
            }
        }
        this.keyChain = keychain;
        return keychain;
    }

    getKeychain(){
        return this.keyChain;
    }

    // Returns all key pairs up to hd index
    getAllDerivedKeys(upTo = this.hdIndex): AVMKeyPair[] | PlatformVMKeyPair[]{
        let set: AVMKeyPair[] | PlatformVMKeyPair[] = [];
        for(var i=0; i<=upTo;i++){
            if(this.chainId==='X'){
                let key = this.getKeyForIndex(i) as AVMKeyPair;
                (set as AVMKeyPair[]).push(key);
            }else{
                let key = this.getKeyForIndex(i) as PlatformVMKeyPair;
                (set as PlatformVMKeyPair[]).push(key);
            }
        }
        return set;
    }

    getAllDerivedAddresses(limit=this.hdIndex): string[]{
        let res = [];
        for(var i=0;i<=limit;i++){
            let addr = this.getAddressForIndex(i);
            res.push(addr);
        }
        return res;
    }


    clearCache(){
        this.keyCache = {};
        this.addressCache = {};
    }

    // Scans the address space for utxos and finds a gap of INDEX_RANGE
    async findAvailableIndex(start:number=0): Promise<number> {
        let addrs: string[] = [];

        // Get keys for indexes start to start+scan_size
        for(let i:number=start;i<start+SCAN_SIZE;i++){
            let address = this.getAddressForIndex(i);
            addrs.push(address);
        }

        let utxoSet;

        if(this.chainId==='X'){
            utxoSet = (await avm.getUTXOs(addrs)).utxos;
        }else{
            utxoSet = (await pChain.getUTXOs(addrs)).utxos;
        }


        // Scan UTXOs of these indexes and try to find a gap of INDEX_RANGE
        for(let i:number=0; i<addrs.length-INDEX_RANGE; i++) {
            let gapSize: number = 0;
            // console.log(`Scan index: ${this.chainId} ${this.changePath}/${i+start}`);
            for(let n:number=0;n<INDEX_RANGE;n++) {
                let scanIndex: number = i + n;
                let addr: string = addrs[scanIndex];
                let addrBuf = bintools.parseAddress(addr, this.chainId);
                let addrUTXOs: string[] = utxoSet.getUTXOIDs([addrBuf]);
                if(addrUTXOs.length === 0){
                    gapSize++
                }else{
                    // Potential improvement
                    i = i+n;
                    break;
                }
            }

            // If we found a gap of 20, we can return the last fullIndex+1
            if(gapSize===INDEX_RANGE){
                let targetIndex = start+i;
                // As a last resort check the explorer
                let data = await this.checkIndexExplorer(targetIndex)
                if(data) continue;
                return targetIndex;
            }
        }
        return await this.findAvailableIndex(start+SCAN_RANGE)
    }

    // Get tx history data for the index from the explorer
    // return true if this address has a history
    // returns false if no explorer is present
    async checkIndexExplorer(index: number): Promise<boolean>{
        let addr = this.getAddressForIndex(index);

        try{
            if(this.chainId==='X'){
                let res = await getAddressDetailX(addr)
                if(res) return true;
            }
        }catch(e){
            // IF there is no available api, catch the 404 and return false
            return false;
        }
        return false;
    }

    // Returns the key of the first index that has no utxos
    getFirstAvailableKey(){
        for(var i=0; i<this.hdIndex; i++){
            let key = this.getKeyForIndex(i);
            let utxoIds = this.utxoSet.getUTXOIDs([key.getAddress()]);
            if(utxoIds.length === 0){
                return key;
            }
        }
        return this.getCurrentKey();
    }

    // Returns the key of the first index that has no utxos
    getFirstAvailableAddress(): string{
        for(var i=0; i<this.hdIndex; i++){
            let addr = this.getAddressForIndex(i);
            let addrBuf = bintools.parseAddress(addr,this.chainId);
            let utxoIds = this.utxoSet.getUTXOIDs([addrBuf]);
            if(utxoIds.length === 0){
                return addr;
            }
        }
        return this.getCurrentAddress();
    }

    getCurrentKey():AVMKeyPair|PlatformVMKeyPair {
        let index: number = this.hdIndex;
        return this.getKeyForIndex(index);
    }

    getCurrentAddress(): string{
        let index = this.hdIndex;
        return this.getAddressForIndex(index);
    }

    // TODO: Public wallet should never be using this
    getKeyForIndex(index: number, isPrivate: boolean = true): AVMKeyPair|PlatformVMKeyPair {
        // If key is cached return that
        let cacheExternal: AVMKeyPair|PlatformVMKeyPair;

        if(this.chainId==='X'){
            cacheExternal = this.keyCache[index] as AVMKeyPair;
        }else{
            cacheExternal = this.keyCache[index] as PlatformVMKeyPair;
        }

        if(cacheExternal) return cacheExternal;

        let derivationPath: string = `${this.changePath}/${index.toString()}`;

        // Get key from cache, if not generate it
        let key: HDKey;
        if(this.hdCache[index]){
            key = this.hdCache[index];
        }else{
            key = this.masterKey.derive(derivationPath) as HDKey;
            this.hdCache[index] = key;
        }

        let pkHex: string;
        if(!this.isPublic){
            pkHex = key.privateKey.toString('hex');
        }else{
            pkHex = key.publicKey.toString('hex');
        }

        let pkBuf: Buffer = new Buffer(pkHex, 'hex');
        let keypair = this.keyChain.importKey(pkBuf)

        // save to cache
        this.keyCache[index] = keypair;
        return keypair;
    }

    getAddressForIndex(index: number): string{


        if(this.addressCache[index]){
            return this.addressCache[index];
        }

        let derivationPath: string = `${this.changePath}/${index.toString()}`;
        // let key: HDKey = this.masterKey.derive(derivationPath) as HDKey;

        // Get key from cache, if not generate it
        let key: HDKey;
        if(this.hdCache[index]){
            key = this.hdCache[index];
        }else{
            key = this.masterKey.derive(derivationPath) as HDKey;
            this.hdCache[index] = key;
        }

        let pkHex = key.publicKey.toString('hex');
        let pkBuff = Buffer.from(pkHex, 'hex');
        let hrp = getPreferredHRP(ava.getNetworkID());

        let chainId = this.chainId;

        // No need for PlatformKeypair because addressToString uses chainID to decode
        let keypair = new AVMKeyPair(hrp, chainId);
        let addrBuf = keypair.addressFromPublicKey(pkBuff);
        let addr = bintools.addressToString(hrp, chainId, addrBuf);

        this.addressCache[index] = addr;
        return addr;
    }
}
export {HdHelper};
