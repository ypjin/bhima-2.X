/**
 * Cashflow Controller
 *
 *
 * This controller is responsible for processing cashflow report.
 *
 * @module finance/cashflow
 *
 * @requires lodash
 * @requires moment
 * @requires lib/db
 * @requires lib/ReportManager
 * @requires lib/errors/BadRequest
 */


const _ = require('lodash');
const Moment = require('moment');

const db = require('../../../../lib/db');
const ReportManager = require('../../../../lib/ReportManager');
const BadRequest = require('../../../../lib/errors/BadRequest');

const identifiers = require('../../../../config/identifiers');

const TEMPLATE = './server/controllers/finance/reports/cashflow/report.handlebars';
const TEMPLATE_BY_SERVICE = './server/controllers/finance/reports/cashflow/reportByService.handlebars';

// TODO(@jniles) - merge this into the regular accounts controller
const AccountsExtra = require('../../accounts/extra');

// expose to the API
exports.report = report;
exports.weeklyReport = weeklyReport;
exports.document = document;

exports.byService = reportByService;

/**
 * @function report
 * @desc This function is responsible of generating the cashflow data for the report
 */
function report(req, res, next) {
  const params = req.query;

  processingCashflowReport(params)
    .then(result => {
      res.status(200).json(result);
    })
    .catch(next);
}

/** processingCashflowReport */
function processingCashflowReport(params) {
  const glb = {};

  if (!params.account_id) {
    throw new BadRequest('Cashbox is missing', 'ERRORS.BAD_REQUEST');
  }

  params.dateFrom = Moment(params.dateFrom).format('YYYY-MM-DD').toString();
  params.dateTo = Moment(params.dateTo).format('YYYY-MM-DD').toString();

  // get all periods for the the current fiscal year
  return getPeriods(params.dateFrom, params.dateTo)
    .then((periods) => {
      // get the closing balance (previous fiscal year) for the selected cashbox
      if (!periods.length) {
        throw new BadRequest('Periods not found due to a bad date interval', 'ERRORS.BAD_DATE_INTERVAL');
      }
      glb.periods = periods;
      return AccountsExtra.getOpeningBalanceForDate(params.account_id, glb.periods[0].start_date, false);
    })
    .then((balance) => {
      const openningBalance = { balance : 0 };

      if (balance) { openningBalance.balance = balance; }
      glb.openningBalance = openningBalance;

      return queryIncomeExpense(params);
    })
    .then((result) => {
      return groupByPeriod(glb.periods, result);
    })
    .then(groupingIncomeExpenseByPeriod)
    .then((flw) => {
      return {
        openningBalance : glb.openningBalance,
        flows : flw,
      };
    });
}

/**
 * @function queryIncomeExpense
 * @param {object} params
 * @param {object} dateFrom The stating date to considerate
 * @param {object} dateTo The stop date to considerate
 * @description returns incomes and expenses data in a promise
 */
function queryIncomeExpense(params, dateFrom, dateTo) {
  if (params && dateFrom && dateTo) {
    params.dateFrom = dateFrom;
    params.dateTo = dateTo;
  }

  const requette = `
    SELECT BUID(t.uuid) AS uuid, t.trans_id, t.trans_date, t.period_id, a.number, a.label,
      SUM(t.debit_equiv) AS debit_equiv, SUM(t.credit_equiv) AS credit_equiv,
      t.debit, t.credit, t.currency_id, t.description, t.comment,
      BUID(t.record_uuid) AS record_uuid, t.origin_id, u.display_name,
      x.text AS transactionType
    FROM (        
      SELECT gl.project_id, gl.uuid, gl.record_uuid, gl.trans_date, gl.period_id,
        gl.debit_equiv, gl.credit_equiv, gl.debit, gl.credit,
        gl.account_id, gl.entity_uuid, gl.currency_id, gl.trans_id,
        gl.description, gl.comment, gl.origin_id, gl.user_id
      FROM general_ledger gl
      WHERE gl.account_id = ? AND
        DATE(gl.trans_date) >= DATE(?) AND
        DATE(gl.trans_date) <= DATE(?) AND
        gl.origin_id <> 10 AND
        gl.record_uuid NOT IN
        (SELECT reference_uuid FROM voucher WHERE type_id = 10)
    ) AS t, account AS a, user as u, transaction_type as x
    WHERE t.account_id = a.id AND t.user_id = u.id AND t.origin_id = x.id
    GROUP BY t.trans_id ;`;

  return db.exec(
    requette,
    [
      params.account_id,
      params.dateFrom,
      params.dateTo,
    ]);
}

/**
 * @function groupingIncomeExpenseByPeriod
 * @description This function help to group incomes or expenses by period
 */
function groupingIncomeExpenseByPeriod(periodicFlows) {
  var grouping = [];
  periodicFlows.forEach((pf) => {
    const incomes = pf.flows.filter((posting) => {
      return posting.debit_equiv > 0;
    });
    const expenses = pf.flows.filter((posting) => {
      return posting.credit_equiv > 0;
    });

    grouping.push({ period : pf.period, incomes, expenses });
  });

  return grouping;
}

/**
 * @function groupByPeriod
 * @param {array} periods An array which contains all periods for the fiscal year
 * @param {array} flows The result of queryIncomeExpense i.e. all incomes and expense
 * @description This function help to group incomes or expenses by month
 */
function groupByPeriod(periods, flows, weekly) {
  var grouping = [];
  periods.forEach((p) => {
    var data = [];
    flows.forEach((f) => {
      if (weekly) {
        const transDate = new Date(f.trans_date);
        const startDate = new Date(p.start_date);
        const endDate = new Date(p.end_date);
        if (transDate <= endDate && transDate >= startDate) {
          data.push(f);
        }
      } else if (p.id === f.period_id) {
        data.push(f);
      }
    });
    grouping.push({ period : p, flows : data });
  });
  return grouping;
}

/**
 * =============================================================================
 * Date Week Manipulations
 * =============================================================================
 */

/** @function weeklyReport */
function weeklyReport(req, res, next) {
  const params = req.query;

  processingWeekCashflow(params)
    .then(result => {
      res.status(200).json(result);
    })
    .catch(next);
}

/** @function processingWeekCashflow */
function processingWeekCashflow(params) {
  const glb = {};

  if (!params.account_id) {
    throw new BadRequest('Cashbox is missing', 'ERRORS.BAD_REQUEST');
  }

  params.dateFrom = Moment(params.dateFrom).format('YYYY-MM-DD').toString();
  params.dateTo = Moment(params.dateTo).format('YYYY-MM-DD').toString();

  glb.periods = getWeeks(params.dateFrom, params.dateTo);
  glb.balance = { balance : 0, account_id : params.account_id };

  if (!glb.periods.length) {
    throw new BadRequest('Periods not found due to a bad date interval', 'ERRORS.BAD_DATE_INTERVAL');
  }

  // Using dateFrom as the beginning of all periods, To avoid using dates not included in fiscal years
  glb.periods[0].start_date = params.dateFrom;

  return AccountsExtra.getOpeningBalanceForDate(params.account_id, glb.periods[0].start_date)
  .then((balance) => {
    let openningBalance = { balance : 0, account_id : params.account_id };

    if (balance) { openningBalance = balance; }
    glb.openningBalance = openningBalance;

    // get all periods for the the current fiscal year
    return queryIncomeExpense(params);
  })
  .then(result => groupByPeriod(glb.periods, result, params.weekly))
  .then(groupingIncomeExpenseByPeriod)
  .then((flows) => {
    return { openningBalance : glb.openningBalance, flows };
  });
}

/** @function getWeeks */
function getWeeks(dateFrom, dateTo) {
  const inc = 0;
  const weeks = [];

  let first = Moment(dateFrom, 'YYYY-MM-DD');
  let last = Moment(dateTo, 'YYYY-MM-DD');

  do {
    first = Moment(first).startOf('week');
    last = Moment(first).endOf('week');

    weeks.push({ week : inc + 1, start_date : first.toDate(), end_date : last.toDate() });

    first = first.add(7, 'days');
  } while (first.toDate() <= new Date(dateTo));
  return weeks;
}

/**
 * @function closingBalance
 * @param {number} accountId An account for which we search to know the balance
 * @param {date} periodStart The first period start of a given fiscal year (current fiscal year)
 * @desc This function help us to get the balance at cloture for a set of accounts
 */
// function closingBalance(accountId, periodStart) {
//   const query = `
//       SELECT SUM(debit_equiv - credit_equiv) as balance, account_id
//       FROM
//       (
//         (
//           SELECT debit_equiv, credit_equiv, account_id, currency_id
//           FROM posting_journal
//           WHERE account_id IN (?) AND fiscal_year_id = ?
//         ) UNION ALL (
//           SELECT debit_equiv, credit_equiv, account_id, currency_id
//           FROM general_ledger
//           WHERE account_id IN (?) AND fiscal_year_id = ?
//         )
//       ) as t;`;

//   return getFiscalYear(periodStart)
//     .then((rows) => {
//       var fy = rows[0];
//       return db.exec(query, [accountId, fy.previous_fiscal_year_id, accountId, fy.previous_fiscal_year_id]);
//     });
// }

/**
 * @function getFiscalYear
 * @param {object} date The date in which we want to get the fiscal year
 * @description
 * This function is responsible of returning a correct fiscal year
 * according a date given
 */
// function getFiscalYear(date) {
//   var query =
//     `SELECT fy.id, fy.previous_fiscal_year_id FROM fiscal_year fy
//      JOIN period p ON p.fiscal_year_id = fy.id
//      WHERE ? BETWEEN p.start_date AND p.end_date`;
//   return db.exec(query, [date]);
// }

/**
 * @function getPeriods
 * @param {date} dateFrom A starting date
 * @param {date} dateTo A stop date
 */
function getPeriods(dateFrom, dateTo) {
  var query =
    `SELECT id, number, start_date, end_date
     FROM period WHERE (DATE(start_date) >= DATE(?) AND DATE(end_date) <= DATE(?))
      OR (DATE(?) BETWEEN DATE(start_date) AND DATE(end_date))
      OR (DATE(?) BETWEEN DATE(start_date) AND DATE(end_date));`;
  return db.exec(query, [dateFrom, dateTo, dateFrom, dateTo]);
}

/**
 * @function document
 * @description process and render the cashflow report document
 */
function document(req, res, next) {
  const session = {};
  const params = req.query;

  let documentReport;
  session.dateFrom = params.dateFrom;
  session.dateTo = params.dateTo;

  // weekly parameter
  session.weekly = Number(params.weekly);

  // FIXME Manual assignment of user, should be done generically for PDF reports
  _.defaults(params, { orientation : 'landscape', user : req.session.user });

  try {
    documentReport = new ReportManager(TEMPLATE, req.session, params);
  } catch (e) {
    next(e);
    return;
  }

  const promise = parseInt(params.weekly, 10) ? processingWeekCashflow : processingCashflowReport;

  promise(params)
    .then(reporting)
    .then(labelization)
    .then(() => documentReport.render(session))
    .then(result => {
      res.set(result.headers).send(result.report);
    })
    .catch(next);

  /**
   * @function reporting
   * @param {array} rows all transactions of the given cashbox
   * @description
   * processing data for the report, the process is as follow
   * step 1. initialization : initialize all global array and objects
   * step 2. openning balance : process for getting the openning balance
   * step 3. grouping : group incomes and expenses by periods
   * step 4. summarization : get all periodical openning balance
   * step 5. labelization : define unique labels for incomes and expenses,
   * and process all totals needed
   * @todo: Must convert values with enterprise exchange rate
   */
  function reporting(rows) {
    initialization();
    session.periodicData = rows.flows;
    /** @todo: convert into enterprise currency */
    session.openningBalance = rows.openningBalance.balance;

    session.periodicData.forEach((flow) => {
      groupingResult(flow.incomes, flow.expenses, Moment(flow.period.start_date).format('YYYY-MM-DD'));
    });

    session.periodStartArray = session.periodicData.map((flow) => {
      return Moment(flow.period.start_date).format('YYYY-MM-DD');
    });

    /** openning balance by period */
    session.periodicData.forEach((flow) => {
      summarization(Moment(flow.period.start_date).format('YYYY-MM-DD'));
    });

    // date range
    session.periodRange = session.periodicData.map(flow => {
      return {
        start : Moment(flow.period.start_date).format('YYYY-MM-DD'),
        end : Moment(flow.period.end_date).format('YYYY-MM-DD'),
      };
    });
  }

  /**
   * @function initialization
   * @description initialize global arrays and objects for the cashflow report
   */
  function initialization() {
    session.incomes = {};
    session.expenses = {};
    session.summationIncome = {};
    session.summationExpense = {};
    session.sum_incomes = {};
    session.sum_expense = {};
    session.periodicBalance = {};
    session.periodicOpenningBalance = {};
    session.incomesLabels = [];
    session.expensesLabels = [];
    session.totalIncomes = {};
    session.totalExpenses = {};
  }

  /**
   * @function summarization
   * @param {object} period An object wich reference a specific period
   * @description process for getting openning balance for each periods
   */
  function summarization(period) {
    session.sum_incomes[period] = 0;
    session.sum_expense[period] = 0;

    if (session.summationIncome[period]) {
      session.summationIncome[period].forEach((transaction) => {
        // if only cashes values must be in only enterprise currency
        /** @todo: convert into enterprise currency */
        session.sum_incomes[period] += transaction.value;
        session.incomesLabels.push(transaction.transfer_type);
      });
    }

    if (session.summationExpense[period]) {
      session.summationExpense[period].forEach((transaction) => {
        // if only cashes values must be in only enterprise currency
        /** @todo: convert into enterprise currency */
        session.sum_expense[period] += transaction.value;
        session.expensesLabels.push(transaction.transfer_type);
      });
    }

    session.periodicBalance[period] = isFirstPeriod(period) ?
      ((Number(session.openningBalance) + Number(session.sum_incomes[period])) - Number(session.sum_expense[period])) :
      ((Number(session.periodicBalance[previousPeriod(period)]) +
        Number(session.sum_incomes[period])) -
        Number(session.sum_expense[period])
      );

    session.periodicOpenningBalance[period] = isFirstPeriod(period) ?
      session.openningBalance :
      session.periodicBalance[previousPeriod(period)];
  }

  /**
   * @function isFirstPeriod
   * @param {object} period An object wich reference a specific period
   * @description process to know the first period in the fiscal year
   */
  function isFirstPeriod(period) {
    var reference = session.periodStartArray[0];

    var bool = (new Date(reference).getDate() === 1 && new Date(reference).getMonth() === 0) ?
      new Date(period).getDate() === 1 && new Date(period).getMonth() === 0 :
      new Date(period).getDate() === new Date(reference).getDate() &&
      new Date(period).getMonth() === new Date(reference).getMonth() &&
      new Date(period).getYear() === new Date(reference).getYear();

    return bool;
  }

  /**
   * @function previousPeriod
   * @param {object} period An object wich reference a specific period
   * @description process to know the previous period of the given period
   */
  function previousPeriod(period) {
    var currentIndex = session.periodStartArray.indexOf(Moment(period).format('YYYY-MM-DD'));
    return (currentIndex !== 0) ? session.periodStartArray[currentIndex - 1] : session.periodStartArray[currentIndex];
  }

  /**
   * @function labelization
   * @description process for getting unique labels for incomes and expenses,
   * and all totals needed
   */
  function labelization() {
    session.incomesLabels = _.uniq(session.incomesLabels);
    session.expensesLabels = _.uniq(session.expensesLabels);

    /** incomes rows */
    session.periodStartArray.forEach((period) => {
      session.incomes[period] = {};
      session.incomesLabels.forEach((label) => {
        session.summationIncome[period].forEach((transaction) => {
          if (transaction.transfer_type === label) {
            /** @todo: convert into enterprise currency */
            session.incomes[period][label] = transaction.value;
          }
        });
      });
    });

    /** totals incomes rows */
    session.periodStartArray.forEach((period) => {
      session.totalIncomes[period] = 0;
      session.summationIncome[period].forEach((transaction) => {
        /** @todo: convert into enterprise currency */
        session.totalIncomes[period] += transaction.value;
      });
    });

    /** expense rows */
    session.periodStartArray.forEach((period) => {
      session.expenses[period] = {};
      session.expensesLabels.forEach((label) => {
        session.summationExpense[period].forEach((transaction) => {
          if (transaction.transfer_type === label) {
            /** @todo: convert into enterprise currency */
            session.expenses[period][label] = transaction.value;
          }
        });
      });
    });

    /** totals expenses rows */
    session.periodStartArray.forEach((period) => {
      session.totalExpenses[period] = 0;
      session.summationExpense[period].forEach((transaction) => {
        /** @todo: convert into enterprise currency */
        session.totalExpenses[period] += transaction.value;
      });
    });
  }

  /**
   * @function groupingResult
   * @param {object} period An object wich reference a specific period
   * @param {array} incomes An array which contain incomes for the period
   * @param {array} expenses An array which contain expenses for the period
   * @description group incomes and expenses by origin_id for each period
   */
  function groupingResult(incomes, expenses, period) {
    session.summationIncome[period] = [];
    session.summationExpense[period] = [];

    // pick the cashbox account name
    if (!session.accountName && incomes.length) {
      session.accountName = incomes[0].label;
    } else if (!session.accountName && expenses.lenght) {
      session.accountName = expenses[0].label;
    } else {
      session.accountName = session.accountName;
    }

    // income
    if (incomes) {
      incomes.forEach((item) => {
        if (item.origin_id) {
          const value = incomes.reduce((a, b) => {
            return b.origin_id === item.origin_id ? b.debit_equiv + a : a;
          }, 0);

          session.summationIncome[period].push({
            transfer_type : item.transactionType,
            currency_id   : item.currency_id,
            value,
          });
        }
      });
    }

    // Removing duplicates
    const cacheIncome = {};
    session.summationIncome[period] = session.summationIncome[period].filter((elem) => {
      const hasElement = cacheIncome[elem.transfer_type];
      if (hasElement) {
        return false;
      }

      cacheIncome[elem.transfer_type] = 1;
      return true;
    });

    // Expense
    if (expenses) {
      expenses.forEach((item) => {
        if (item.origin_id) {
          const value = expenses.reduce((a, b) => {
            return b.origin_id === item.origin_id ? b.credit_equiv + a : a;
          }, 0);

          session.summationExpense[period].push({
            value,
            transfer_type : item.transactionType,
            currency_id   : item.currency_id,
          });
        }
      });
    }

    // Removing duplicates
    const cacheExpense = {};
    session.summationExpense[period] = session.summationExpense[period].filter((elem) => {
      const hasElement = cacheExpense[elem.transfer_type];
      if (hasElement) {
        return false;
      }

      cacheExpense[elem.transfer_type] = 1;
      return true;
    });
  }
}

/**
 * This function creates a cashflow report by service, reporting the realized income
 * for the hospital services.
 *
 * @todo - factor in cash reversals.
 * @todo - factor in posting journal balances
 */
function reportByService(req, res, next) {
  const dateFrom = new Date(req.query.dateFrom);
  const dateTo = new Date(req.query.dateTo);

  let serviceReport;

  const options = _.clone(req.query);
  _.extend(options, { orientation : 'landscape' });

  try {
    serviceReport = new ReportManager(TEMPLATE_BY_SERVICE, req.session, options);
  } catch (e) {
    next(e);
    return;
  }

  const data = {};
  data.dateFrom = dateFrom;
  data.dateTo = dateTo;

  let emptyCashValues = false;

  // get the cash flow data
  const cashflowByServiceSql = `
    SELECT uuid, reference, date, cashAmount, invoiceAmount, currency_id, service_id,
      display_name, name, (@cumsum := cashAmount + @cumsum) AS cumsum
    FROM (
      SELECT BUID(cash.uuid) AS uuid,
        CONCAT_WS('.', '${identifiers.CASH_PAYMENT.key}', project.abbr, cash.reference) AS reference,
        cash.date, cash.amount AS cashAmount, SUM(invoice.cost) AS invoiceAmount, cash.currency_id,
        service.id AS service_id, patient.display_name, service.name
      FROM cash JOIN cash_item ON cash.uuid = cash_item.cash_uuid
        JOIN invoice ON cash_item.invoice_uuid = invoice.uuid
        JOIN project ON cash.project_id = project.id
        JOIN patient ON patient.debtor_uuid = cash.debtor_uuid
        JOIN service ON invoice.service_id = service.id
      WHERE cash.is_caution = 0 AND cash.reversed = 0
        AND DATE(cash.date) >= DATE(?) AND DATE(cash.date) <= DATE(?)
      GROUP BY cash.uuid
      ORDER BY cash.date, cash.reference
    )c, (SELECT @cumsum := 0)z
    ORDER BY date, reference;
  `;

  // get all service names in alphabetical order
  const serviceSql = `
    SELECT DISTINCT service.name FROM service WHERE service.id IN (?) ORDER BY name;
  `;

  // get the totals of the captured records
  const serviceAggregationSql = `
    SELECT service.name, SUM(cash.amount) AS totalCashIncome, SUM(invoice.cost) AS totalAcruelIncome
    FROM cash JOIN cash_item ON cash.uuid = cash_item.cash_uuid
      JOIN invoice ON cash_item.invoice_uuid = invoice.uuid
      JOIN service ON invoice.service_id = service.id
    WHERE cash.is_caution = 0 AND cash.reversed = 0
      AND DATE(cash.date) >= DATE(?) AND DATE(cash.date) <= DATE(?)
    GROUP BY service.name
    ORDER BY service.name;
  `;

  db.exec(cashflowByServiceSql, [dateFrom, dateTo])
    .then((rows) => {
      data.rows = rows;

      // return an empty array if no rows
      if (!rows.length) {
        emptyCashValues = true;
        return [];
      }

      // get a list of unique service ids
      const serviceIds = rows
        .map(row => row.service_id)
        .filter((id, index, array) => array.indexOf(id) === index);

      // execute the service SQL
      return db.exec(serviceSql, [serviceIds]);
    })
    .then((services) => {
      // if nothing matches the selection criteria, continue with nothing
      if (emptyCashValues) {
        return [];
      }

      const rows = data.rows;
      delete data.rows;

      // map services to their service names
      data.services = services.map(service => service.name);

      const xAxis = data.services.length;

      // fill the matrix with nulls except the correct columns
      const matrix = rows.map((row) => {
        // fill line with each service + two lines for cash payment identifier and patient name
        const line = _.fill(Array(xAxis + 3), null);

        // each line has the cash payment reference and then the patient name
        line[0] = row.reference;
        line[1] = row.display_name;

        // get the index of the service name and fill in the correct cell in the matrix
        const idx = data.services.indexOf(row.name) + 2;
        line[idx] = row.cashAmount;

        // get the far right row as the total
        line[xAxis + 2] = row.cumsum;
        return line;
      });

      // bind to the view
      data.matrix = matrix;

      // query the aggregates
      return db.exec(serviceAggregationSql, [dateFrom, dateTo]);
    })
    .then((aggregates) => {
      data.aggregates = aggregates;

      // the total of everything is just the last running balance amount
      if (data.matrix) {
        const lastRow = data.matrix[data.matrix.length - 1];
        const lastRowTotalIdx = lastRow.length - 1;
        aggregates.push({ totalCashIncome : lastRow[lastRowTotalIdx] });
      }

      return serviceReport.render(data);
    })
    .then((result) => {
      res.set(result.headers).send(result.report);
    })
    .catch(next)
    .done();
}
