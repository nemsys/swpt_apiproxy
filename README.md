Swaptacular Web API reverse proxy
=================================

This project implements a load balancing HTTP reverse proxy, that forwards
[Swaptacular] Web API requests to servers. It is intended to be used when
several instances ([shards]) of [Accounting Authority], [Creditors Agent],
or [Debtors Agent] Web API servers are deployed. The ultimate deliverable is
a [docker image], generated from the project's
[Dockerfile](../master/Dockerfile).


How it works
------------

The reverse proxy extracts the creditor's and/or debtor's ID from the the
incoming HTTP request, calculates a 32-bit sharding key (using a strictly
defined algorithm), and then, based on the sharding key, decides to which
server to forward the incoming request.


Configuration
-------------

The behavior of the running container can be tuned with environment
variables. Here are the most important settings with some random example
values:

```shell
# To configure a "Creditors Agent" proxy, the MIN_CREDITOR_ID and
# MAX_CREDITOR_ID environment variables must be set, indicating
# that the creditors agent will be responsible for creditor IDs
# between "$MIN_CREDITOR_ID" and "$MAX_CREDITOR_ID". The values
# can be formatted as decimal integers (negative decimal integers
# are allowed), or as hexadecimal non-negative integers (with
# the "0x" prefix).
MIN_CREDITOR_ID=4294967296
MAX_CREDITOR_ID=8589934591

# To configure a "Debtors Agent" proxy, the MIN_DEBTOR_ID and
# MAX_DEBTOR_ID environment variables must be set, indicating
# that the debtors agent will be responsible for debtor IDs
# between "$MIN_DEBTOR_ID" and "$MAX_DEBTOR_ID". The values can
# be formatted as decimal integers (negative decimal integers are
# allowed), or as hexadecimal non-negative integers (with
# the "0x" prefix).
MIN_DEBTOR_ID=0x100000000
MAX_DEBTOR_ID=0x1ffffffff

# To configure an "Accounting Authority" proxy, *none of the*
# MIN_CREDITOR_ID, MAX_CREDITOR_ID, MIN_DEBTOR_ID and
# MAX_DEBTOR_ID environment variables must be set.


# The proxy will listen for HTTP requests on
# port "$APIPROXY_PORT" (default 8080). The path "/healthz" can be
# used as a readyness/liveness probe, and if the server has started,
# it will always return an HTTP 200 status code.
APIPROXY_PORT=8080

# The full path to the configuration file. Each line in the
# configuration file should start with a route specifier,
# followed by at least one space, followed by a web server
# URL (only "http://" server URLs are supported). Route
# specifiers consist of zero or more 0s or 1s, separated by dots,
# ending with a hash symbol ("#"). An example configuration file:
#
# 0.# http://first-server:8001
# 1.# http://second-server:8001
#
# or, for a sigle server:
#
# # http://the-only-server
#
# Note that the APIPROXY_CONFIG_FILE environment variable *must*
# be set, and the route specifiers in the configuration file must
# cover all possible bit masks. For example, the following
# configuration file is invalid:
#
# 0.# http://some-server
#
# because it does not cover sharding keys starting with a
# binary "1".
#
# Note: If the configuration file changes, the change will will
# be detected by the API proxy, and the new configuration will be
# loaded and applied automatically.
APIPROXY_CONFIG_FILE=/etc/apiproxy.conf

# The maximum size (in bytes) of request bodies that the proxy
# itself has to receive in full (this is the case only for the
# random ID reservation requests). Bigger requests will be
# rejected with a 413 status code. The default is 65536.
APIPROXY_MAX_BODY_SIZE=65536
```


[Swaptacular]: https://swaptacular.github.io/overview
[docker image]: https://www.geeksforgeeks.org/what-is-docker-images/
[shards]: https://en.wikipedia.org/wiki/Shard_(database_architecture)
[Accounting Authority]: https://github.com/swaptacular/swpt_accounts
[Creditors Agent]: https://github.com/swaptacular/swpt_creditors
[Debtors Agent]: https://github.com/swaptacular/swpt_debtors

