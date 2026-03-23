<?php

namespace Test\Foo\Model;

class DataObject
{
    public function getData(string $key = '')
    {
        return null;
    }

    public function setData($key, $value = null)
    {
        return $this;
    }

    public function __call($method, $args)
    {
        return null;
    }
}
