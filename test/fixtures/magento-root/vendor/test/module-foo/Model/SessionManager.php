<?php

namespace Test\Foo\Model;

/**
 * @method string getCustomerId()
 * @method $this setCustomerId(string $id)
 */
class SessionManager
{
    public function __call($method, $args)
    {
        return null;
    }

    public function start(): void
    {
    }
}
