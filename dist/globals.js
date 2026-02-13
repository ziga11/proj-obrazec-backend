export class Globals {
    _account = null;
    set account(acc) {
        this._account = acc;
    }
    get getAccount() {
        return this._account;
    }
}
