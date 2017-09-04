angular.module('bhima.controllers')
  .controller('GenericIncomeKitController', GenericIncomeKitController);

GenericIncomeKitController.$inject = [
  '$uibModalInstance', 'NotifyService', 'CashboxService',
  'data', 'AccountStoreService', 'bhConstants', 'VoucherToolkitService',
];

// Import transaction rows for a convention payment
function GenericIncomeKitController(Instance, Notify, Cashbox, Data, AccountStore, bhConstants, ToolKits) {
  var vm = this;

  // global variables
  vm.tool = Data;

  // expose to the view
  vm.close = Instance.close;
  vm.import = submit;

  // accounts from store
  AccountStore.accounts()
    .then(function (data) {
      vm.accounts = data;
    })
    .catch(Notify.handleError);

  // load cashboxes
  Cashbox.read(null, { detailed: 1 })
    .then(function (data) {
      vm.cashboxes = data;
    })
    .catch(Notify.handleError);

  // generate transaction rows
  function generateTransactionRows(params) {
    var rows = [];

    var debitRow = ToolKits.getBlankVoucherRow();
    var creditRow = ToolKits.getBlankVoucherRow();

    var cashboxAccountId = params.cashbox.account_id;
    var selectedAccountId = params.account.id;

    // debit the cashbox
    debitRow.account_id = cashboxAccountId;
    debitRow.debit = vm.amount;
    debitRow.credit = 0;
    rows.push(debitRow);

    // credit the selected account
    creditRow.account_id = selectedAccountId;
    creditRow.debit = 0;
    creditRow.credit = vm.amount;
    rows.push(creditRow);

    return rows;
  }

  // submission
  function submit(form) {
    if (form.$invalid) { return; }

    var bundle = generateTransactionRows({
      cashbox : vm.cashbox,
      account : vm.account,
    });

    Instance.close({
      rows        : bundle,
      description : vm.description,
      type_id     : bhConstants.transactionType.GENERIC_INCOME, // Generic Income ID
      currency_id : vm.cashbox.currency_id,
    });
  }
}
